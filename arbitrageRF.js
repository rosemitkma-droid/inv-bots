/**
 * DERIV HEDGED BOT v3.3 - ENHANCED TRADE NOTIFICATIONS
 * - Detailed trade entry notifications (Telegram + Console)
 * - Comprehensive trade result notifications with P/L breakdown
 * - Beautiful formatting and emoji indicators
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
const CONFIG = {
    API_TOKEN: 'rgNedekYXvCaPeP',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    
    INITIAL_CAPITAL: 250,
    BASE_STAKE: 1.0,
    RISK_PERCENT: 1.0, // Percentage of capital to risk per trade (1% = 0.01)
    
    ACTIVE_ASSETS: ['R_10', 'R_25', 'R_50', 'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4' , 'stpRNG5'], //['R_10', 'R_25', 'R_50', 'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4' , 'stpRNG5']
    
    HEDGE_MIN_SCORE: 10,
    HEDGE_MAX_DIFF: 10,
    MIN_SCORE_TO_TRADE: 10,
    
    DALEMBERT_UNIT: 0.5,
    MAX_DALEMBERT_STEPS: 5,
    
    MAX_CONSECUTIVE_LOSSES: 7,
    DAILY_PROFIT_TARGET: 25,
    DAILY_STOP_LOSS: -20,
    
    GRANULARITY: 60,
    CANDLES_TO_LOAD: 100,
    DURATION: 5,
    DURATION_UNIT: 't',
    
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
    
    DEBUG_MODE: true,
    ANALYSIS_LOGGING: true,
    
    // NEW: Notification settings
    NOTIFY_ALL_ENTRIES: true,      // Send telegram for all trade entries
    NOTIFY_ALL_RESULTS: true,      // Send telegram for all trade results
    NOTIFY_MIN_PROFIT: 1,          // Only notify if P/L > this amount
};

// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    analysis: msg => { if (CONFIG.ANALYSIS_LOGGING) console.log(`\x1b[36m[ANALYSIS] ${getGMTTime()} - ${msg}\x1b[0m`); },
    
    // NEW: Enhanced trade logging
    entry: (msg) => {
        console.log('\n' + '┌' + '─'.repeat(78) + '┐');
        console.log(`│ \x1b[1m\x1b[33m🎯 TRADE ENTRY - ${getGMTTime()}\x1b[0m`.padEnd(88) + '│');
        console.log('├' + '─'.repeat(78) + '┤');
        msg.split('\n').forEach(line => {
            console.log(`│ \x1b[33m${line}\x1b[0m`.padEnd(88) + '│');
        });
        console.log('└' + '─'.repeat(78) + '┘\n');
    },
    
    result: (msg, isWin) => {
        const color = isWin ? '\x1b[32m' : '\x1b[31m';
        const icon = isWin ? '✅ WIN' : '❌ LOSS';
        console.log('\n' + '┌' + '─'.repeat(78) + '┐');
        console.log(`│ \x1b[1m${color}${icon} - ${getGMTTime()}\x1b[0m`.padEnd(88) + '│');
        console.log('├' + '─'.repeat(78) + '┤');
        msg.split('\n').forEach(line => {
            console.log(`│ ${color}${line}\x1b[0m`.padEnd(88) + '│');
        });
        console.log('└' + '─'.repeat(78) + '┘\n');
    }
};

// ============================================
const HISTORY_FILE = path.join(__dirname, 'HedgedBot_05-history.json');
let tradeHistory = {
    overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, hedges: 0, firstTradeDate: null, lastTradeDate: null },
    dailyHistory: {},
    lastUpdated: Date.now()
};

class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }
    
    static loadHistory() {
        try {
            if (fs.existsSync(HISTORY_FILE)) {
                tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                LOGGER.info(`📂 Loaded history: ${tradeHistory.overall.tradesCount} trades`);
            }
        } catch (e) { LOGGER.error(`History load failed: ${e.message}`); }
    }
    
    static saveHistory() {
        try {
            tradeHistory.lastUpdated = Date.now();
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        } catch (e) { LOGGER.error(`History save failed: ${e.message}`); }
    }
    
    static recordTrade(symbol, profit, isHedge = false) {
        const dateKey = this.getDateKey();
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = { 
                date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0, 
                profit: 0, loss: 0, netPL: 0, hedges: 0, 
                startCapital: state.capital, endCapital: state.capital 
            };
        }
        const day = tradeHistory.dailyHistory[dateKey];
        const overall = tradeHistory.overall;
        
        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;
        
        day.tradesCount++; overall.tradesCount++;
        day.endCapital = state.capital;
        
        if (isHedge) { day.hedges++; overall.hedges++; }
        
        if (profit > 0) { 
            day.winsCount++; overall.winsCount++; 
            day.profit += profit; overall.profit += profit; 
        } else if (profit < 0) { 
            day.lossesCount++; overall.lossesCount++; 
            day.loss += Math.abs(profit); overall.loss += Math.abs(profit); 
        }
        
        day.netPL += profit; overall.netPL += profit;
        this.saveHistory();
    }
    
    static getTodayStats() {
        const dateKey = this.getDateKey();
        const today = tradeHistory.dailyHistory[dateKey] || {
            tradesCount: 0, winsCount: 0, lossesCount: 0, 
            profit: 0, loss: 0, netPL: 0
        };
        
        return {
            trades: today.tradesCount,
            wins: today.winsCount,
            losses: today.lossesCount,
            winRate: today.tradesCount > 0 ? (today.winsCount / today.tradesCount * 100).toFixed(1) : '0.0',
            netPL: today.netPL
        };
    }
}

// ============================================
class TelegramService {
    static async sendMessage(message, silent = false) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({ 
                chat_id: CONFIG.TELEGRAM_CHAT_ID, 
                text: message, 
                parse_mode: 'HTML',
                disable_notification: silent
            });
            
            return new Promise((resolve) => {
                const req = https.request(url, { 
                    method: 'POST', 
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Content-Length': Buffer.byteLength(data) 
                    } 
                }, res => { 
                    res.on('data', () => {}); 
                    res.on('end', () => resolve(true)); 
                });
                
                req.on('error', (e) => { 
                    LOGGER.debug(`Telegram error: ${e.message}`); 
                    resolve(false); 
                });
                req.write(data); 
                req.end();
            });
        } catch (e) { 
            LOGGER.debug(`Telegram exception: ${e.message}`); 
        }
    }
    
    // NEW: Format trade entry notification
    static formatTradeEntry(tradeInfo) {
        const { symbol, direction, stake, score, entrySpot, isHedge, contractId } = tradeInfo;
        const stats = TradeHistoryManager.getTodayStats();
        
        let msg = `🎯 <b>TRADE ENTRY${isHedge ? ' (HEDGE)' : ''}</b>\n`;
        msg += `${'─'.repeat(30)}\n\n`;
        
        msg += `📊 <b>Asset:</b> ${symbol}\n`;
        msg += `${direction === 'CALLE' ? '📈' : '📉'} <b>Direction:</b> ${direction}\n`;
        msg += `💰 <b>Stake:</b> $${stake.toFixed(2)}\n`;
        msg += `📍 <b>Entry Price:</b> ${entrySpot}\n\n`;
        
        msg += `📈 <b>Score Rise:</b> ${score.rise}/10\n`;
        msg += `📉 <b>Score Fall:</b> ${score.fall}/10\n`;
        msg += `🎯 <b>RSI:</b> ${score.rsi} (${score.trend})\n`;
        msg += `📊 <b>BB Position:</b> ${score.bbPosition}%\n\n`;
        
        if (score.reasonsRise.length > 0 || score.reasonsFall.length > 0) {
            msg += `💡 <b>Signals:</b>\n`;
            if (direction === 'CALLE' && score.reasonsRise.length > 0) {
                msg += `   ${score.reasonsRise.slice(0, 3).join('\n   ')}\n`;
            } else if (direction === 'PUTE' && score.reasonsFall.length > 0) {
                msg += `   ${score.reasonsFall.slice(0, 3).join('\n   ')}\n`;
            }
            msg += '\n';
        }
        
        msg += `💼 <b>Balance:</b> $${state.capital.toFixed(2)}\n`;
        msg += `📊 <b>Today:</b> ${stats.trades} trades | ${stats.wins}W/${stats.losses}L (${stats.winRate}%)\n`;
        msg += `📈 <b>Daily P/L:</b> $${state.dailyPL.toFixed(2)}\n\n`;
        
        msg += `🆔 <code>${contractId}</code>\n`;
        msg += `⏰ ${new Date().toLocaleString('en-US', { timeZone: 'GMT', hour12: false })} GMT`;
        
        return msg;
    }
    
    // NEW: Format trade result notification
    static formatTradeResult(resultInfo) {
        const { symbol, direction, profit, entrySpot, exitSpot, duration, isHedge, stake, buyPrice, sellPrice } = resultInfo;
        const isWin = profit >= 0;
        
        let msg = `${isWin ? '✅' : '❌'} <b>${isWin ? 'WIN' : 'LOSS'}${isHedge ? ' (HEDGE)' : ''}</b>\n`;
        msg += `${'─'.repeat(30)}\n\n`;
        
        msg += `📊 <b>Asset:</b> ${symbol}\n`;
        msg += `${direction === 'CALLE' ? '📈' : '📉'} <b>Direction:</b> ${direction}\n\n`;
        
        msg += `📍 <b>Entry:</b> ${entrySpot}\n`;
        msg += `🎯 <b>Exit:</b> ${exitSpot}\n`;
        msg += `📊 <b>Movement:</b> ${this.formatPriceMovement(entrySpot, exitSpot, direction)}\n\n`;
        
        msg += `💰 <b>Stake:</b> $${stake.toFixed(2)}\n`;
        msg += `💵 <b>Buy Price:</b> $${buyPrice.toFixed(2)}\n`;
        msg += `💸 <b>Sell Price:</b> $${sellPrice.toFixed(2)}\n`;
        msg += `${isWin ? '💚' : '💔'} <b>Profit/Loss:</b> ${isWin ? '+' : ''}$${profit.toFixed(2)} (${this.formatROI(profit, stake)})\n\n`;
        
        msg += `⏱️ <b>Duration:</b> ${duration}s\n`;
        msg += `💼 <b>New Balance:</b> $${state.capital.toFixed(2)}\n\n`;

        const stats = TradeHistoryManager.getTodayStats();
        
        msg += `📊 <b>Today's Stats:</b>\n`;
        msg += `   Trades: ${stats.trades} | W/L: ${stats.wins}/${stats.losses} (${stats.winRate}%)\n`;
        msg += `   Daily P/L: ${stats.netPL >= 0 ? '+' : ''}$${stats.netPL.toFixed(2)}\n`;
        msg += `   Streak: ${state.consecutiveLosses > 0 ? `${state.consecutiveLosses} losses` : 'No losses'}\n\n`;
        
        msg += `⏰ ${new Date().toLocaleString('en-US', { timeZone: 'GMT', hour12: false })} GMT`;
        
        return msg;
    }
    
    static formatPriceMovement(entry, exit, direction) {
        const entryNum = parseFloat(entry);
        const exitNum = parseFloat(exit);
        const diff = exitNum - entryNum;
        const diffPct = (diff / entryNum * 100).toFixed(3);
        const correct = (direction === 'CALLE' && diff > 0) || (direction === 'PUTE' && diff < 0);
        
        return `${diff >= 0 ? '+' : ''}${diff.toFixed(5)} (${diff >= 0 ? '+' : ''}${diffPct}%) ${correct ? '✓' : '✗'}`;
    }
    
    static formatROI(profit, stake) {
        const roi = (profit / stake * 100).toFixed(1);
        return `${roi >= 0 ? '+' : ''}${roi}%`;
    }
}

// ============================================
class ConfluenceScorer {
    static calculateScore(candles) {
        if (candles.length < 30) {
            return { 
                rise: 0, fall: 0, rsi: 0, trend: 'NONE', bbWidth: 0, price: 0,
                details: 'Not enough candles', reasonsRise: [], reasonsFall: [] 
            };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const current = closes[closes.length - 1];
        
        const rsi = this.RSI(closes, 14);
        const bb = this.BB(closes, 20, 2);
        const ema5 = this.EMA(closes, 5);
        const ema20 = this.EMA(closes, 20);
        const ema50 = this.EMA(closes, 50);
        const atr = this.ATR(highs, lows, closes, 14);
        const bbWidth = (bb.upper - bb.lower) / bb.middle * 100;
        
        let rise = 0, fall = 0;
        let reasonsRise = [], reasonsFall = [];
        
        // TREND ANALYSIS
        if (ema5 > ema20 && ema20 > ema50) { 
            rise += 4; 
            reasonsRise.push('✓ Strong uptrend (EMA alignment)'); 
        } else if (ema5 < ema20 && ema20 < ema50) { 
            fall += 4; 
            reasonsFall.push('✓ Strong downtrend (EMA alignment)'); 
        } else if (ema5 > ema20) { 
            rise += 2; 
            reasonsRise.push('✓ Short-term bullish'); 
        } else if (ema5 < ema20) { 
            fall += 2; 
            reasonsFall.push('✓ Short-term bearish'); 
        }
        
        // RSI ANALYSIS
        if (rsi < 30) { 
            rise += 3; 
            reasonsRise.push(`✓ RSI oversold (${rsi.toFixed(1)})`); 
        } else if (rsi < 40) { 
            rise += 2; 
            reasonsRise.push(`✓ RSI low (${rsi.toFixed(1)})`); 
        } else if (rsi > 70) { 
            fall += 3; 
            reasonsFall.push(`✓ RSI overbought (${rsi.toFixed(1)})`); 
        } else if (rsi > 60) { 
            fall += 2; 
            reasonsFall.push(`✓ RSI high (${rsi.toFixed(1)})`); 
        }
        
        // BOLLINGER BANDS
        const bbPosition = ((current - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1);
        
        if (current <= bb.lower) { 
            rise += 3; 
            reasonsRise.push(`✓ Price at lower BB`); 
        } else if (current < bb.middle) { 
            rise += 1; 
            reasonsRise.push(`✓ Below BB middle`); 
        }
        
        if (current >= bb.upper) { 
            fall += 3; 
            reasonsFall.push(`✓ Price at upper BB`); 
        } else if (current > bb.middle) { 
            fall += 1; 
            reasonsFall.push(`✓ Above BB middle`); 
        }
        
        // VOLATILITY
        if (bbWidth < 0.15) { 
            rise += 2; fall += 2; 
            reasonsRise.push(`✓ Tight squeeze (breakout setup)`); 
            reasonsFall.push(`✓ Tight squeeze (breakout setup)`); 
        }
        
        return { 
            rise: Math.min(10, rise), 
            fall: Math.min(10, fall), 
            rsi: rsi.toFixed(1), 
            trend: ema5 > ema20 ? 'BULL' : 'BEAR',
            bbWidth: bbWidth.toFixed(3),
            bbPosition,
            price: current.toFixed(5),
            reasonsRise,
            reasonsFall
        };
    }
    
    static RSI(c, p) {
        let gains = 0, losses = 0;
        for (let i = c.length - p + 1; i < c.length; i++) {
            const change = c[i] - c[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / p;
        const avgLoss = losses / p || 0.0001;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }
    
    static BB(c, period, stdDev) {
        const slice = c.slice(-period);
        const sma = slice.reduce((a, b) => a + b) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
        const sd = Math.sqrt(variance);
        return {
            middle: sma,
            upper: sma + stdDev * sd,
            lower: sma - stdDev * sd
        };
    }
    
    static EMA(c, period) {
        const k = 2 / (period + 1);
        let ema = c.slice(0, period).reduce((a, b) => a + b) / period;
        for (let i = period; i < c.length; i++) {
            ema = c[i] * k + ema * (1 - k);
        }
        return ema;
    }
    
    static ATR(highs, lows, closes, period) {
        let trs = [];
        for (let i = 1; i < closes.length; i++) {
            trs.push(Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            ));
        }
        return trs.slice(-period).reduce((a, b) => a + b) / period;
    }
}

// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    dailyPL: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    isPaused: false,
    dalembertLevel: 0,
    assets: {},
    activeHedges: new Map(),
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    candlesReceived: 0,
};

CONFIG.ACTIVE_ASSETS.forEach(s => {
    state.assets[s] = { 
        closedCandles: [], 
        lastTradeTime: 0, 
        lastAnalysis: null 
    };
});

// ============================================
class HedgedBot {
    constructor() {
        this.ws = null;
        this.requestId = 1;
        this.pendingTrades = new Map();
        this.pingInterval = null;
        TradeHistoryManager.loadHistory();
        this.connect();
    }
    
    connect() {
        LOGGER.info('🔌 Connecting...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        
        this.ws.on('open', () => { 
            this.send({ authorize: CONFIG.API_TOKEN });
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.send({ ping: 1 });
                }
            }, 30000);
        });
        
        this.ws.on('message', data => this.onMessage(JSON.parse(data)));
        
        this.ws.on('close', () => { 
            LOGGER.warn('⚠️ Connection closed. Reconnecting in 5s...'); 
            clearInterval(this.pingInterval); 
            setTimeout(() => this.connect(), 5000); 
        });
        
        this.ws.on('error', (e) => LOGGER.error(`WebSocket Error: ${e.message}`));
    }
    
    send(data) { 
        if (this.ws.readyState !== WebSocket.OPEN) {
            LOGGER.warn('Cannot send - WebSocket not open');
            return 0;
        }
        data.req_id = this.requestId++; 
        this.ws.send(JSON.stringify(data)); 
        return data.req_id; 
    }
    
    onMessage(res) {
        if (res.error) {
            LOGGER.error(`API Error [${res.msg_type || 'unknown'}]: ${res.error.message}`);
            if (res.error.code === 'InputValidationFailed') {
                LOGGER.error(`Validation details: ${JSON.stringify(res.error.details)}`);
            }
            return;
        }
        
        if (res.msg_type === 'authorize') {
            state.capital = res.authorize.balance;
            LOGGER.info(`🔐 Authorized | Balance: $${state.capital.toFixed(2)} | Currency: ${res.authorize.currency}`);
            LOGGER.info(`📡 Subscribing to ${CONFIG.ACTIVE_ASSETS.length} assets...`);
            CONFIG.ACTIVE_ASSETS.forEach(s => this.subscribe(s));
        }
        
        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            if (!state.assets[sym]) return;
            
            state.assets[sym].closedCandles = res.candles.map(c => ({ 
                open: +c.open, 
                close: +c.close, 
                high: +c.high, 
                low: +c.low, 
                epoch: +c.epoch 
            }));
            
            const latest = state.assets[sym].closedCandles.slice(-1)[0];
            LOGGER.info(`📈 ${sym} | Loaded ${res.candles.length} candles | Latest: ${latest.close.toFixed(5)}`);
        }
        
        if (res.msg_type === 'ohlc') {
            state.candlesReceived++;
            this.onCandle(res.ohlc);
        }
        
        if (res.msg_type === 'buy') {
            const pending = this.pendingTrades.get(res.echo_req.req_id);
            if (pending) {
                const contractId = res.buy.contract_id;
                const buyPrice = +res.buy.buy_price;
                
                // Store trade info
                const tradeInfo = { 
                    ...pending, 
                    contractId,
                    buyPrice,
                    startTime: Date.now()
                };
                
                state.activeHedges.set(contractId, tradeInfo);
                
                // ✅ ENHANCED ENTRY LOGGING
                const entryLog = 
                    `Asset: ${pending.symbol} | Direction: ${pending.direction}${pending.isHedge ? ' (HEDGE)' : ''}\n` +
                    `Stake: $${pending.stake.toFixed(2)} | Entry: ${pending.entrySpot}\n` +
                    `Score: R${pending.score.rise}/F${pending.score.fall} | RSI: ${pending.score.rsi} (${pending.score.trend})\n` +
                    `Signals: ${pending.direction === 'CALLE' ? pending.score.reasonsRise.slice(0, 2).join(', ') : pending.score.reasonsFall.slice(0, 2).join(', ')}\n` +
                    `Contract ID: ${contractId}`;
                
                LOGGER.entry(entryLog);
                
                // ✅ SEND TELEGRAM NOTIFICATION FOR ENTRY
                if (CONFIG.NOTIFY_ALL_ENTRIES) {
                    TelegramService.sendMessage(TelegramService.formatTradeEntry(tradeInfo));
                }
                
                this.send({ 
                    proposal_open_contract: 1, 
                    contract_id: contractId, 
                    subscribe: 1 
                });
                
                this.pendingTrades.delete(res.echo_req.req_id);
            }
        }
        
        if (res.msg_type === 'proposal_open_contract') {
            const c = res.proposal_open_contract;
            if (c.is_sold) {
                const h = state.activeHedges.get(c.contract_id);
                if (!h) return;
                
                const profit = +c.profit;
                const sellPrice = +c.sell_price;
                const exitSpot = c.exit_tick || c.exit_tick_display_value || 'N/A';
                const duration = ((Date.now() - h.startTime) / 1000).toFixed(1);
                
                state.capital += profit; 
                state.dailyPL += profit; 
                state.tradesToday++;
                
                const isWin = profit >= 0;
                
                // ✅ ENHANCED RESULT LOGGING
                const resultLog =
                    `Asset: ${h.symbol} | Direction: ${h.direction}${h.isHedge ? ' (HEDGE)' : ''}\n` +
                    `Entry: ${h.entrySpot} → Exit: ${exitSpot}\n` +
                    `Movement: ${TelegramService.formatPriceMovement(h.entrySpot, exitSpot, h.direction)}\n` +
                    `Stake: $${h.stake.toFixed(2)} | Buy: $${h.buyPrice.toFixed(2)} | Sell: $${sellPrice.toFixed(2)}\n` +
                    `P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${TelegramService.formatROI(profit, h.stake)}) | Duration: ${duration}s\n` +
                    `New Balance: $${state.capital.toFixed(2)} | Daily: ${state.dailyPL >= 0 ? '+' : ''}$${state.dailyPL.toFixed(2)}\n` +
                    `Contract ID: ${c.contract_id}`;
                
                LOGGER.result(resultLog, isWin);
                
                // ✅ SEND TELEGRAM NOTIFICATION FOR RESULT
                if (CONFIG.NOTIFY_ALL_RESULTS || Math.abs(profit) >= CONFIG.NOTIFY_MIN_PROFIT) {
                    const resultInfo = {
                        symbol: h.symbol,
                        direction: h.direction,
                        profit,
                        entrySpot: h.entrySpot,
                        exitSpot,
                        duration,
                        isHedge: h.isHedge,
                        stake: h.stake,
                        buyPrice: h.buyPrice,
                        sellPrice
                    };
                    TelegramService.sendMessage(TelegramService.formatTradeResult(resultInfo));
                }
                
                TradeHistoryManager.recordTrade(h.symbol, profit, h.isHedge);
                state.activeHedges.delete(c.contract_id);
                
                // D'Alembert adjustment
                if (profit > 0) { 
                    state.dalembertLevel = Math.max(0, state.dalembertLevel - 1); 
                    state.consecutiveLosses = 0; 
                } else { 
                    state.dalembertLevel = Math.min(CONFIG.MAX_DALEMBERT_STEPS, state.dalembertLevel + 1); 
                    state.consecutiveLosses++; 
                }
                
                // Circuit breaker
                if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    state.isPaused = true;
                    const pauseMsg = `⏸️ BOT PAUSED - ${state.consecutiveLosses} consecutive losses\nBalance: $${state.capital.toFixed(2)}\nResuming in 5 minutes...`;
                    LOGGER.warn(pauseMsg);
                    TelegramService.sendMessage(`⚠️ <b>CIRCUIT BREAKER ACTIVATED</b>\n\n${pauseMsg}`);
                    
                    setTimeout(() => {
                        state.isPaused = false;
                        state.consecutiveLosses = 0;
                        LOGGER.info('▶️ Resumed trading');
                        TelegramService.sendMessage('▶️ <b>Trading Resumed</b>');
                    }, 300000);
                }
            }
        }
        
        if (res.msg_type === 'ping') {
            LOGGER.debug('🏓 Pong');
        }
    }
    
    subscribe(s) {
        LOGGER.info(`→ Subscribing ${s}...`);
        
        this.send({ 
            ticks_history: s, 
            end: 'latest',
            count: CONFIG.CANDLES_TO_LOAD, 
            style: 'candles', 
            granularity: CONFIG.GRANULARITY 
        });
        
        this.send({ 
            ticks_history: s, 
            subscribe: 1, 
            style: 'candles', 
            granularity: CONFIG.GRANULARITY,
            end: 'latest'
        });
    }
    
    onCandle(ohlc) {
        const asset = state.assets[ohlc.symbol];
        if (!asset) return;
        
        const candle = { 
            open: +ohlc.open, 
            close: +ohlc.close, 
            high: +ohlc.high, 
            low: +ohlc.low, 
            epoch: +ohlc.epoch 
        };
        
        asset.closedCandles.push(candle);
        if (asset.closedCandles.length > 200) asset.closedCandles.shift();
        
        if (asset.closedCandles.length < 50) {
            LOGGER.debug(`${ohlc.symbol} - Building history (${asset.closedCandles.length}/50)`);
            return;
        }
        
        const score = ConfluenceScorer.calculateScore(asset.closedCandles);
        asset.lastAnalysis = score;
        
        LOGGER.analysis(
            `${ohlc.symbol} | Price:${score.price} | ` +
            `RISE:${score.rise} [${score.reasonsRise.slice(0, 2).join('; ') || 'none'}] | ` +
            `FALL:${score.fall} [${score.reasonsFall.slice(0, 2).join('; ') || 'none'}] | ` +
            `RSI:${score.rsi} ${score.trend} BB:${score.bbPosition}%`
        );
        
        if (state.isPaused) {
            LOGGER.analysis(`⏸️ ${ohlc.symbol} SKIPPED - Bot paused`);
            return;
        }
        
        if (state.dailyPL <= CONFIG.DAILY_STOP_LOSS) {
            LOGGER.warn(`🛑 ${ohlc.symbol} SKIPPED - Daily stop loss hit ($${state.dailyPL.toFixed(2)})`);
            return;
        }
        
        if (state.dailyPL >= CONFIG.DAILY_PROFIT_TARGET) {
            LOGGER.info(`🎯 ${ohlc.symbol} SKIPPED - Daily profit target reached ($${state.dailyPL.toFixed(2)})`);
            return;
        }
        
        if (state.activeHedges.size >= 6) {
            LOGGER.analysis(`⏸️ ${ohlc.symbol} SKIPPED - Max concurrent trades (${state.activeHedges.size})`);
            return;
        }
        
        if (Date.now() - asset.lastTradeTime < 30000) {
            const wait = Math.ceil((30000 - (Date.now() - asset.lastTradeTime)) / 1000);
            LOGGER.analysis(`⏳ ${ohlc.symbol} SKIPPED - Cooldown ${wait}s`);
            return;
        }
        
        const shouldHedge = 
            score.rise >= CONFIG.HEDGE_MIN_SCORE && 
            score.fall >= CONFIG.HEDGE_MIN_SCORE && 
            Math.abs(score.rise - score.fall) <= CONFIG.HEDGE_MAX_DIFF;
        
        const shouldRise = 
            score.rise >= CONFIG.MIN_SCORE_TO_TRADE && 
            score.rise > score.fall + 2;
        
        const shouldFall = 
            score.fall >= CONFIG.MIN_SCORE_TO_TRADE && 
            score.fall > score.rise + 2;
        
        if (shouldHedge) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: HEDGE (R:${score.rise}/F:${score.fall})`);
            asset.lastTradeTime = Date.now();
            this.executeHedge(ohlc.symbol, score, candle.close);
        } else if (shouldRise) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: CALLE (R:${score.rise} > F:${score.fall})`);
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'CALLE', score, candle.close);
        } else if (shouldFall) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: PUTE (F:${score.fall} > R:${score.rise})`);
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'PUTE', score, candle.close);
        } else {
            LOGGER.analysis(`❌ ${ohlc.symbol} NO TRADE - Insufficient scores`);
        }
    }
    
    getStake() { 
        const riskStake = state.capital * (CONFIG.RISK_PERCENT / 100);
        const dalembertStake = CONFIG.BASE_STAKE + (state.dalembertLevel * CONFIG.DALEMBERT_UNIT);
        const maxStake = state.capital * 0.05;
        return Math.min(dalembertStake, riskStake, maxStake);
    }
    
    executeSingle(symbol, direction, score, entryPrice) {
        const stake = this.getStake();
        
        const req_id = this.send({ 
            buy: 1, 
            price: stake.toFixed(2), 
            parameters: { 
                contract_type: direction, 
                symbol, 
                amount: stake.toFixed(2),
                duration: CONFIG.DURATION, 
                duration_unit: CONFIG.DURATION_UNIT, 
                basis: 'stake', 
                currency: 'USD' 
            }
        });
        
        this.pendingTrades.set(req_id, { 
            symbol, 
            direction, 
            stake, 
            score, 
            isHedge: false, 
            entrySpot: entryPrice.toFixed(5) 
        });
    }
    
    executeHedge(symbol, score, entryPrice) {
        const stake = this.getStake() * 0.6;
        
        const callReq = this.send({ 
            buy: 1, 
            price: stake.toFixed(2), 
            parameters: { 
                contract_type: 'CALLE', 
                symbol, 
                amount: stake.toFixed(2),
                duration: CONFIG.DURATION, 
                duration_unit: CONFIG.DURATION_UNIT, 
                basis: 'stake', 
                currency: 'USD' 
            }
        });
        this.pendingTrades.set(callReq, { 
            symbol, 
            direction: 'CALLE', 
            stake, 
            score, 
            isHedge: true, 
            entrySpot: entryPrice.toFixed(5) 
        });
        
        setTimeout(() => {
            const putReq = this.send({ 
                buy: 1, 
                price: stake.toFixed(2), 
                parameters: { 
                    contract_type: 'PUTE', 
                    symbol, 
                    duration: CONFIG.DURATION, 
                    duration_unit: CONFIG.DURATION_UNIT, 
                    basis: 'stake', 
                    currency: 'USD' 
                }
            });
            this.pendingTrades.set(putReq, { 
                symbol, 
                direction: 'PUTE', 
                stake, 
                score, 
                isHedge: true, 
                entrySpot: entryPrice.toFixed(5) 
            });
        }, 300);
    }
}

// ============================================
// START BOT
// ============================================
console.log('\n' + '═'.repeat(80));
console.log('  🤖 DERIV HEDGED BOT v3.3 - ENHANCED NOTIFICATIONS');
console.log('═'.repeat(80));
console.log(`  💰 Capital: $${CONFIG.INITIAL_CAPITAL}`);
console.log(`  📊 Base Stake: $${CONFIG.BASE_STAKE} (D'Alembert: +$${CONFIG.DALEMBERT_UNIT}/level)`);
console.log(`  📈 Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
console.log(`  ⏱️  Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT === 't' ? 'ticks' : 'seconds'}`);
console.log(`  📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED ✅' : 'DISABLED ❌'}`);
console.log(`  🔔 Entry Notifications: ${CONFIG.NOTIFY_ALL_ENTRIES ? 'ALL' : 'DISABLED'}`);
console.log(`  🔔 Result Notifications: ${CONFIG.NOTIFY_ALL_RESULTS ? 'ALL' : `P/L > $${CONFIG.NOTIFY_MIN_PROFIT}`}`);
console.log('═'.repeat(80) + '\n');

new HedgedBot();

// Status updates every minute
setInterval(() => {
    const stats = TradeHistoryManager.getTodayStats();
    
    LOGGER.info(
        `📊 Capital:$${state.capital.toFixed(2)} | ` +
        `Daily:${state.dailyPL >= 0 ? '+' : ''}$${state.dailyPL.toFixed(2)} | ` +
        `Trades:${stats.trades} (${stats.winRate}% win) | ` +
        `Active:${state.activeHedges.size} | ` +
        `D'Alembert:+${state.dalembertLevel}`
    );
    
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const asset = state.assets[sym];
        if (asset.lastAnalysis) {
            const s = asset.lastAnalysis;
            LOGGER.info(`   ${sym}: R:${s.rise}/F:${s.fall} | ${s.trend} | RSI:${s.rsi} | BB:${s.bbPosition}%`);
        }
    });
}, 60000);

// Hourly summary via Telegram
setInterval(() => {
    const stats = TradeHistoryManager.getTodayStats();
    const msg = 
        `📊 <b>HOURLY SUMMARY</b>\n` +
        `${'─'.repeat(30)}\n\n` +
        `💼 <b>Balance:</b> $${state.capital.toFixed(2)}\n` +
        `📈 <b>Daily P/L:</b> ${stats.netPL >= 0 ? '+' : ''}$${stats.netPL.toFixed(2)}\n` +
        `📊 <b>Trades:</b> ${stats.trades} | W/L: ${stats.wins}/${stats.losses}\n` +
        `🎯 <b>Win Rate:</b> ${stats.winRate}%\n` +
        `🔄 <b>Active Trades:</b> ${state.activeHedges.size}\n` +
        `📉 <b>Streak:</b> ${state.consecutiveLosses > 0 ? `${state.consecutiveLosses} losses` : 'No losses'}\n\n` +
        `⏰ ${new Date().toLocaleString('en-US', { timeZone: 'GMT' })} GMT`;
    
    TelegramService.sendMessage(msg, true); // Silent notification
}, 3600000); // Every hour
