/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        DERIV RELIABLE ACCUMULATOR BOT  v4.0                 ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY:                                                   ║
 * ║  • Bollinger Band Squeeze Detection on real tick prices      ║
 * ║  • RSI(14) filter — avoid directional extremes              ║
 * ║  • Price Momentum / Stability check                          ║
 * ║  • Strict entry window: ticks 0–8 (fresh contracts only)    ║
 * ║  • Adaptive Growth Rate: 1% default → 2% on strong squeeze  ║
 * ║  • FLAT STAKING — no Martingale (knockout = 100% loss)      ║
 * ║  • Per-asset cooldowns after losses                          ║
 * ║  • Multi-asset rotation with single active trade             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — edit values here or override via environment
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
    // Deriv API
    token: '0P94g4WdSrSrzir', //process.env.DERIV_TOKEN || 
    appId: 1089, //process.env.DERIV_APP_ID || 
    wsUrl: 'wss://ws.derivws.com/websockets/v3',

    // Assets to trade (ordered by preference — lowest volatility first)
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'], // '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'

    // Staking  (FLAT — no Martingale)
    initialStake: 1.00,   // USD per trade
    multiplier: 6.00,   // never exceed this
    multiplier2: 8.00,   // never exceed this

    // Growth rates
    growthRateDefault: 0.01,   // 1% — widest barriers, safest
    growthRateBoost: 0.02,   // 2% — only on strong squeeze + RSI centred

    // Entry window (ENFORCED): only enter when active accumulator is this young
    minEntryTick: 0,
    maxEntryTick: 10,

    // Take-profit (contract level): sell when profit ≥ X% of stake
    takeProfitPct: 0.20,   // 40% of stake
    // Hard hold limit: never hold longer than this after take-profit window opens
    maxHoldTicks: 20,

    // Bollinger Bands parameters
    bbPeriod: 20,
    bbMultiplier: 2.0,
    // BB width percentile threshold — enter only when market is calm
    bbSqueezePctile: 20,     // below 40th percentile = squeeze (good to enter)

    // RSI parameters
    rsiPeriod: 14,
    rsiLow: 40,     // don't enter if RSI < 35 (trending down hard)
    rsiHigh: 60,     // don't enter if RSI > 65 (trending up hard)

    // Price stability: max average absolute change over last 10 ticks (as % of price)
    maxPriceChangePct: 0.002,  // 0.2%

    // Min history required before analysis
    requiredHistory: 60,

    // Risk management
    maxConsecutiveLosses: 3,
    consecutiveLossCooldownMs: 1800000, // 30 min pause after 3 consec losses
    assetCooldownMs: 1800000, // 30 min asset cooldown on loss
    maxDailyLoss: 500,     // stop bot for the day
    takeProfitSession: 50000,    // stop bot after reaching this profit

    // Proposal throttle: min ms between proposal requests per asset
    // Reduced from 10s to 5s to allow faster re-entry after trade closes
    proposalThrottleMs: 5000,

    // Telegram
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ', //process.env.TELEGRAM_TOKEN || 
    telegramChatId: '752497117', //process.env.TELEGRAM_CHAT_ID || 

    // State persistence
    stateFile: path.join(__dirname, 'accumulator_botB010_state.json'),
    stateSaveMs: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                totalTrades: bot.totalTrades,
                totalWins: bot.totalWins,
                totalLosses: bot.totalLosses,
                totalPnl: bot.totalPnl,
                dailyPnl: bot.dailyPnl,
                consecutiveLosses: bot.consecutiveLosses,
                assetMetrics: bot.assetMetrics,
                currentStake: bot.currentStake,
                consecutiveLosses2: bot.consecutiveLosses2,
                consecutiveLosses3: bot.consecutiveLosses3,
                consecutiveLosses4: bot.consecutiveLosses4,
                consecutiveLosses5: bot.consecutiveLosses5,
            };
            fs.writeFileSync(CONFIG.stateFile, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('State save error:', e.message);
        }
    }

    static load() {
        try {
            if (!fs.existsSync(CONFIG.stateFile)) return null;
            const raw = fs.readFileSync(CONFIG.stateFile, 'utf8');
            const data = JSON.parse(raw);
            const ageMin = (Date.now() - data.savedAt) / 60000;
            if (ageMin > 90) {
                console.warn(`⚠️  Saved state is ${ageMin.toFixed(0)}m old — starting fresh`);
                return null;
            }
            console.log(`📂 Restored state from ${ageMin.toFixed(1)}m ago`);
            return data;
        } catch (e) {
            return null;
        }
    }

    static autoSave(bot) {
        return setInterval(() => {
            if (bot.connected) StatePersistence.save(bot);
        }, CONFIG.stateSaveMs);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VOLATILITY ANALYZER — Bollinger Bands + RSI + Momentum on real prices
// ─────────────────────────────────────────────────────────────────────────────
class VolatilityAnalyzer {
    constructor() {
        this.bbWidthHistory = {}; // last 100 BB widths per asset
    }

    // ── Bollinger Bands ───────────────────────────────────────────────────────
    computeBB(prices, period = CONFIG.bbPeriod, mult = CONFIG.bbMultiplier) {
        if (prices.length < period) return null;

        const slice = prices.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
        const sigma = Math.sqrt(variance);

        return {
            upper: mean + mult * sigma,
            middle: mean,
            lower: mean - mult * sigma,
            width: (2 * mult * sigma) / mean, // normalised width
            sigma,
            mean,
        };
    }

    // ── RSI ───────────────────────────────────────────────────────────────────
    computeRSI(prices, period = CONFIG.rsiPeriod) {
        if (prices.length < period + 1) return null;

        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        const recent = changes.slice(-period);
        let gains = 0, losses = 0;

        // First average
        recent.forEach(c => {
            if (c > 0) gains += c;
            else losses -= c;
        });

        let avgGain = gains / period;
        let avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }

    // ── Price Momentum (avg absolute % change over last N ticks) ─────────────
    computeMomentum(prices, lookback = 10) {
        if (prices.length < lookback + 1) return null;

        const slice = prices.slice(-lookback - 1);
        let sumAbsPctChange = 0;

        for (let i = 1; i < slice.length; i++) {
            sumAbsPctChange += Math.abs((slice[i] - slice[i - 1]) / slice[i - 1]);
        }

        return sumAbsPctChange / lookback; // avg absolute % change per tick
    }

    // ── BB Width Percentile (squeeze detection) ───────────────────────────────
    getBBWidthPercentile(asset, currentWidth) {
        if (!this.bbWidthHistory[asset]) {
            this.bbWidthHistory[asset] = [];
        }

        const history = this.bbWidthHistory[asset];
        history.push(currentWidth);
        if (history.length > 100) history.shift();

        if (history.length < 20) return 50; // not enough data, assume neutral

        const sorted = [...history].sort((a, b) => a - b);
        const rank = sorted.filter(w => w <= currentWidth).length;
        return (rank / sorted.length) * 100;
    }

    // ── Composite Entry Signal ────────────────────────────────────────────────
    /**
     * @returns {{
     *   score: number,        0–1 (higher = better entry)
     *   shouldEnter: boolean,
     *   growthRate: number,   0.01 or 0.02
     *   reason: string,
     *   bb: object|null,
     *   rsi: number|null,
     *   momentum: number|null,
     *   bbWidthPctile: number,
     *   regime: string
     * }}
     */
    analyze(asset, prices) {
        if (prices.length < CONFIG.requiredHistory) {
            return {
                score: 0, shouldEnter: false,
                reason: `insufficient_history (${prices.length}/${CONFIG.requiredHistory})`,
                growthRate: CONFIG.growthRateDefault,
                bb: null, rsi: null, momentum: null, bbWidthPctile: 50, regime: 'warming_up',
            };
        }

        const bb = this.computeBB(prices);
        const rsi = this.computeRSI(prices);
        const momentum = this.computeMomentum(prices);

        if (!bb || rsi === null || momentum === null) {
            return {
                score: 0, shouldEnter: false, reason: 'indicators_not_ready',
                growthRate: CONFIG.growthRateDefault,
                bb, rsi, momentum, bbWidthPctile: 50, regime: 'computing',
            };
        }

        const bbWidthPctile = this.getBBWidthPercentile(asset, bb.width);

        // ── Scoring ──────────────────────────────────────────────────────────
        // 1. Bollinger Band Squeeze Score (lower percentile = better, max at 0)
        let bbScore = 1 - (bbWidthPctile / 100); // 0–1
        bbScore = Math.pow(bbScore, 0.7);     // smooth the curve

        // 2. RSI Score — peak at 50, drops toward 0 and 100
        const rsiCentre = 50;
        const rsiDist = Math.abs(rsi - rsiCentre);
        const rsiScore = Math.max(0, 1 - rsiDist / 40); // 1 at RSI=50, 0 at RSI=10 or 90

        // 3. Momentum Score (lower momentum = better for accumulators)
        const momentumThreshold = CONFIG.maxPriceChangePct;
        const momentumScore = Math.max(0, 1 - momentum / (momentumThreshold * 3));

        // ── Weighted composite ───────────────────────────────────────────────
        const score = (
            bbScore * 0.55 +
            rsiScore * 0.30 +
            momentumScore * 0.15
        );

        // ── Hard gates ───────────────────────────────────────────────────────
        let reason = '';
        let shouldEnter = true;

        if (bbWidthPctile >= CONFIG.bbSqueezePctile) {
            shouldEnter = false;
            reason = `bb_too_wide (pctile=${bbWidthPctile.toFixed(0)}, need<${CONFIG.bbSqueezePctile})`;
        } else if (rsi < CONFIG.rsiLow) {
            shouldEnter = false;
            reason = `rsi_oversold (${rsi.toFixed(1)}<${CONFIG.rsiLow})`;
        } else if (rsi > CONFIG.rsiHigh) {
            shouldEnter = false;
            reason = `rsi_overbought (${rsi.toFixed(1)}>${CONFIG.rsiHigh})`;
        } else if (momentum > CONFIG.maxPriceChangePct) {
            shouldEnter = false;
            reason = `momentum_high (${(momentum * 100).toFixed(3)}%>${(CONFIG.maxPriceChangePct * 100).toFixed(3)}%)`;
        } else if (score < 0.42) {
            shouldEnter = false;
            reason = `composite_score_low (${(score * 100).toFixed(1)}%<42%)`;
        } else {
            reason = 'conditions_met';
        }

        // ── Growth rate selection ─────────────────────────────────────────────
        const strongSqueeze = bbWidthPctile < 20;
        const rsiCentred = rsi >= 44 && rsi <= 56;
        const growthRate = (strongSqueeze && rsiCentred && shouldEnter)
            ? CONFIG.growthRateBoost
            : CONFIG.growthRateDefault;

        // ── Regime label ─────────────────────────────────────────────────────
        let regime = 'neutral';
        if (bbWidthPctile < 20 && rsi >= 44 && rsi <= 56) regime = 'ideal_squeeze';
        else if (bbWidthPctile < 40) regime = 'squeeze';
        else if (bbWidthPctile >= 70) regime = 'expanding';
        else if (rsi < CONFIG.rsiLow) regime = 'oversold';
        else if (rsi > CONFIG.rsiHigh) regime = 'overbought';

        return {
            score, shouldEnter, reason, growthRate,
            bb, rsi, momentum, bbWidthPctile, regime,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK MANAGER
// ─────────────────────────────────────────────────────────────────────────────
class RiskManager {
    constructor() {
        this.assetCooldowns = {}; // { asset: untilTimestamp }
        this.globalPausedUntil = 0;
    }

    setAssetCooldown(asset) {
        this.assetCooldowns[asset] = Date.now() + CONFIG.assetCooldownMs;
        const mins = (CONFIG.assetCooldownMs / 60000).toFixed(0);
        console.log(`🔒 ${asset} cooldown for ${mins} min`);
    }

    isAssetOnCooldown(asset) {
        const until = this.assetCooldowns[asset] || 0;
        return Date.now() < until;
    }

    assetCooldownRemaining(asset) {
        const until = this.assetCooldowns[asset] || 0;
        return Math.max(0, until - Date.now());
    }

    setGlobalPause() {
        this.globalPausedUntil = Date.now() + CONFIG.consecutiveLossCooldownMs;
        const mins = (CONFIG.consecutiveLossCooldownMs / 60000).toFixed(0);
        console.log(`⏸️  Global pause for ${mins} min (consecutive loss limit hit)`);
    }

    isGloballyPaused() {
        return Date.now() < this.globalPausedUntil;
    }

    canTrade(asset, dailyPnl, consecutiveLosses) {
        if (dailyPnl <= -CONFIG.maxDailyLoss) {
            return { allowed: false, reason: `daily_loss_limit ($${CONFIG.maxDailyLoss})` };
        }
        if (this.isGloballyPaused()) {
            const remMin = ((this.globalPausedUntil - Date.now()) / 60000).toFixed(0);
            return { allowed: false, reason: `global_pause (${remMin}m remaining)` };
        }
        if (consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
            return { allowed: false, reason: `consecutive_loss_limit (${consecutiveLosses}/${CONFIG.maxConsecutiveLosses})` };
        }
        if (this.isAssetOnCooldown(asset)) {
            const remMin = (this.assetCooldownRemaining(asset) / 60000).toFixed(0);
            return { allowed: false, reason: `asset_cooldown (${remMin}m remaining)` };
        }
        return { allowed: true };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BOT
// ─────────────────────────────────────────────────────────────────────────────
class ReliableAccumulatorBot {
    constructor() {
        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.maxReconnects = 50;
        this.shutdownFlag = false;
        this.endOfDay = false;
        this.isWinTrade = false;
        this.currentStake = CONFIG.initialStake;
        this.multiplier = CONFIG.multiplier;
        this.multiplier2 = CONFIG.multiplier2;

        // Price history  (raw float prices — used for BB/RSI)
        this.tickPrices = {};  // { asset: [price, price, ...] }
        this.tickSubscriptionIds = {};

        // Per-asset state
        this.assetStates = {};  // { asset: { proposalId, lastProposalAt, lastTicks } }

        // Proposal throttle
        this.lastProposalAt = {};  // { asset: timestamp }

        // Active trade tracking
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.contractSubscriptionId = null;

        // Trade Watchdog — detects and recovers stuck trades
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000; // 2 minutes — Accumulator contracts should settle well before this
        this.tradeStartTime = null;

        // Session stats
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalPnl = 0;
        this.dailyPnl = 0;
        this.consecutiveLosses = 0;
        this.assetMetrics = {};
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;

        // Components
        this.analyzer = new VolatilityAnalyzer();
        this.riskManager = new RiskManager();

        // Asset suspension state
        this.suspendedAssets = new Set();  // Assets that are suspended
        this.focusAsset = null;            // The asset to focus on after a loss

        // Telegram
        this.telegram = (CONFIG.telegramToken && CONFIG.telegramChatId)
            ? new TelegramBot(CONFIG.telegramToken, { polling: false })
            : null;

        // Init per-asset structures
        CONFIG.assets.forEach(asset => {
            this.tickPrices[asset] = [];
            this.assetStates[asset] = { proposalId: null, lastTicks: 0, lastProposalAt: 0 };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        });

        // Restore previous state
        this._loadState();

        this._startTelegramTimer();
    }

    // ── Asset Suspension Logic ────────────────────────────────────────────────
    /**
     * Suspend all assets except the one that just had a loss
     * Focus only on the loss asset until a win occurs
     */
    suspendOtherAssets(lossAsset) {
        this.focusAsset = lossAsset;
        CONFIG.assets.forEach(asset => {
            if (asset !== lossAsset) {
                this.suspendedAssets.add(asset);
            }
        });
        console.log(`🔒 SUSPENDED: All assets except ${lossAsset}. Focusing on loss asset.`);
        this.notify(
            `🔒 <b>Asset Suspension (Bot 3b)</b>\n\n` +
            `Loss on: <b>${lossAsset}</b>\n` +
            `Suspended: ${CONFIG.assets.filter(a => a !== lossAsset).join(', ')}\n` +
            `Focusing on ${lossAsset} until win`
        );
    }

    /**
     * Resume all assets after a win on the focus asset
     */
    resumeAllAssets() {
        const prevFocus = this.focusAsset;
        this.suspendedAssets.clear();
        this.focusAsset = null;
        console.log(`✅ RESUMED: All assets active again (was focused on ${prevFocus})`);
        this.notify(
            `✅ <b>All Assets Resumed (Bot 3b)</b>\n\n` +
            `Won on: <b>${prevFocus}</b>\n` +
            `All assets now active for trading`
        );
    }

    /**
     * Check if an asset is allowed to trade (respects suspension)
     */
    isAssetAllowed(asset) {
        // If no focus asset, all assets are allowed
        if (!this.focusAsset) return true;
        // Only the focus asset is allowed
        return asset === this.focusAsset;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    _loadState() {
        const s = StatePersistence.load();
        if (!s) return;
        this.totalTrades = s.totalTrades || 0;
        this.totalWins = s.totalWins || 0;
        this.totalLosses = s.totalLosses || 0;
        this.totalPnl = s.totalPnl || 0;
        this.dailyPnl = s.dailyPnl || 0;
        this.consecutiveLosses = s.consecutiveLosses || 0;
        this.currentStake = s.currentStake || CONFIG.initialStake;
        this.consecutiveLosses2 = s.consecutiveLosses2 || 0;
        this.consecutiveLosses3 = s.consecutiveLosses3 || 0;
        this.consecutiveLosses4 = s.consecutiveLosses4 || 0;
        this.consecutiveLosses5 = s.consecutiveLosses5 || 0;
        if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
        console.log(`✅ Restored: ${this.totalTrades} trades, P&L $${this.totalPnl.toFixed(2)}`);
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        this._cleanup();

        const url = `${CONFIG.wsUrl}?app_id=${CONFIG.appId}`;
        console.log(`🔌 Connecting to ${url}...`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => this._onOpen());
        this.ws.on('message', (data) => this._onMessage(data));
        this.ws.on('error', (err) => console.error('WS error:', err.message));
        this.ws.on('close', () => this._onClose());
    }

    _onOpen() {
        console.log('✅ Connected to Deriv API');
        this.connected = true;
        this.reconnectAttempts = 0;
        this._send({ authorize: CONFIG.token });
    }

    _onClose() {
        console.log('⚡ WebSocket closed');
        this.connected = false;
        this.wsReady = false;

        if (this.shutdownFlag || this.endOfDay) return;

        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnects) {
            console.error('❌ Max reconnects reached. Exiting.');
            process.exit(1);
        }

        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    _cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (_) { }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
        this._clearWatchdogTimers();
    }

    _send(req) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('⚠️  WS not ready — skipping send');
            return false;
        }
        try {
            this.ws.send(JSON.stringify(req));
            return true;
        } catch (e) {
            console.error('Send error:', e.message);
            return false;
        }
    }

    // ── Message Router ────────────────────────────────────────────────────────
    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.msg_type) {
            case 'authorize': this._handleAuth(msg); break;
            case 'history': this._handleHistory(msg); break;
            case 'tick': this._handleTick(msg); break;
            case 'proposal': this._handleProposal(msg); break;
            case 'buy': this._handleBuy(msg); break;
            case 'proposal_open_contract': this._handleContractUpdate(msg); break;
            case 'sell': this._handleSell(msg); break;
            default:
                if (msg.error) console.error(`API Error [${msg.msg_type}]: ${msg.error.message}`);
        }
    }

    // ── Authentication ────────────────────────────────────────────────────────
    _handleAuth(msg) {
        if (msg.error) {
            console.error('❌ Auth failed:', msg.error.message);
            this.shutdown('auth_failed');
            return;
        }
        const acc = msg.authorize;
        console.log(`✅ Authenticated as ${acc.email || acc.loginid} | Balance: $${acc.balance || 'N/A'}`);
        this.wsReady = true;
        this._initSubscriptions();
    }

    // ── Subscriptions ─────────────────────────────────────────────────────────
    _initSubscriptions() {
        console.log(`📡 Subscribing to ${CONFIG.assets.length} assets...`);

        CONFIG.assets.forEach(asset => {
            // Load historical prices
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: 200,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });

            // Live tick subscription
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    _startTelegramTimer() {
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

    _getLastDigit(quote, asset) {
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

    // _handleHistory(msg) {
    //     if (msg.error) return;
    //     const asset = msg.echo_req.ticks_history;
    //     const prices = (msg.history.prices || []).map(price => this._getLastDigit(price, asset));
    //     this.tickPrices[asset] = prices;
    //     console.log(`📊 ${asset}: Loaded ${prices.length} price ticks`);
    // }

    // ── Live Tick ─────────────────────────────────────────────────────────────
    // _handleTick(msg) {
    //     if (msg.subscription) {
    //         const asset = msg.tick.symbol;
    //         this.tickSubscriptionIds[asset] = msg.subscription.id;
    //     }

    //     const { symbol, quote } = msg.tick;
    //     const price = this._getLastDigit(quote, symbol);
    //     const prices = this.tickPrices[symbol];

    //     if (!prices) return;
    //     prices.push(price);
    //     this.tickPrices[symbol] = prices;

    //     console.log(`📊 ${symbol}: ${prices.slice(-10)} | ${price} (${prices.length})`);

    //     // Keep rolling window of 300 prices
    //     while (prices.length > 300) prices.shift();

    //     // Attempt to request a proposal for this asset
    //     this._maybeRequestProposal(symbol);
    // }

    _handleHistory(msg) {
        if (msg.error) return;
        const asset = msg.echo_req.ticks_history;
        const prices = (msg.history.prices || []).map(Number);
        this.tickPrices[asset] = prices;
        console.log(`📊 ${asset}: Loaded ${prices.length} price ticks`);
    }

    // ── Live Tick ─────────────────────────────────────────────────────────────
    _handleTick(msg) {
        if (msg.subscription) {
            const asset = msg.tick.symbol;
            this.tickSubscriptionIds[asset] = msg.subscription.id;
        }

        const { symbol, quote } = msg.tick;
        const price = Number(quote);
        const prices = this.tickPrices[symbol];

        if (!prices) return;
        prices.push(price);

        const asset = msg.tick.symbol;
        this.tickPrices[asset] = prices;

        // Keep rolling window of 300 prices
        while (prices.length > 300) prices.shift();

        // Attempt to request a proposal for this asset
        this._maybeRequestProposal(symbol);
    }

    // ── Proposal Request (throttled + gated) ──────────────────────────────────
    _maybeRequestProposal(asset) {
        if (this.tradeInProgress) return;
        if (!this.wsReady) return;
        if (this.shutdownFlag) return;

        // Check if asset is suspended
        if (!this.isAssetAllowed(asset)) return;

        const now = Date.now();
        const lastAt = this.assetStates[asset].lastProposalAt || 0;
        const throttled = (now - lastAt) < CONFIG.proposalThrottleMs;
        if (throttled) return;

        // Quick pre-check — only request if history is long enough
        if (this.tickPrices[asset].length < CONFIG.requiredHistory) return;

        // Risk pre-check (no point requesting if we can't trade anyway)
        const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
        if (!risk.allowed) return;

        // Volatility pre-check — run analysis before requesting proposal
        const signal = this.analyzer.analyze(asset, this.tickPrices[asset]);
        if (!signal.shouldEnter) return; // don't even request proposal if signal is bad

        // All checks passed — request proposal
        this.assetStates[asset].lastProposalAt = now;

        const takeProfitAmount = parseFloat((this.currentStake * CONFIG.takeProfitPct).toFixed(2));

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: signal.growthRate,
            limit_order: {
                take_profit: takeProfitAmount.toFixed(2),
            },
        });
    }

    // ── Proposal Handler ──────────────────────────────────────────────────────
    _handleProposal(msg) {
        if (msg.error) {
            if (msg.error.code !== 'ContractBuyValidationError') {
                console.log(`Proposal error [${msg.echo_req?.symbol}]: ${msg.error.message}`);
            }
            return;
        }

        if (!msg.proposal) return;

        const asset = msg.echo_req.symbol;
        const proposal = msg.proposal;

        if (!proposal.contract_details || !proposal.contract_details.ticks_stayed_in) return;

        const stayedIn = proposal.contract_details.ticks_stayed_in;
        this.assetStates[asset].proposalId = proposal.id;

        // Current tick count of the running accumulator
        const currentTick = (stayedIn[stayedIn.length - 1] || 0) + 1;
        this.assetStates[asset].lastTicks = currentTick;

        // ── VOLATILITY SIGNAL ─────────────────────────────────────────────────
        const signal = this.analyzer.analyze(asset, this.tickPrices[asset]);

        this._logAnalysis(asset, currentTick, signal, proposal);

        // Don't trade if already trading
        if (this.tradeInProgress) return;

        if (this.consecutiveLosses < 1) {
            // ── ENTRY WINDOW CHECK (ENFORCED) ────────────────────────────────────
            if (currentTick < CONFIG.minEntryTick) {
                this._log(asset, currentTick, `⏳ Too early (${currentTick}<${CONFIG.minEntryTick})`);
                return;
            }
            if (currentTick > CONFIG.maxEntryTick) {
                this._log(asset, currentTick, `⏰ Too late (${currentTick}>${CONFIG.maxEntryTick})`);
                return;
            }

            // ── RISK CHECK ────────────────────────────────────────────────────────
            const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
            if (!risk.allowed) {
                this._log(asset, currentTick, `🚫 Risk block: ${risk.reason}`);
                return;
            }

            if (signal.growthRate < CONFIG.growthRateBoost) return; // Only trade Very Good signal

            //Execute Trade
            if (signal.shouldEnter) {
                this._executeTrade(asset, proposal, signal, currentTick);
            }
        } else {
            this._executeTrade(asset, proposal, signal, currentTick);
        }
    }

    // ── Trade Execution ───────────────────────────────────────────────────────
    _executeTrade(asset, proposal, signal, currentTick) {
        const proposalId = this.assetStates[asset].proposalId;
        if (!proposalId) {
            console.error(`❌ No proposal ID for ${asset}`);
            return;
        }

        const stake = this.currentStake;  // FLAT STAKING
        const takeProfitAmt = parseFloat((stake * CONFIG.takeProfitPct).toFixed(2));
        const growthLabel = `${(signal.growthRate * 100).toFixed(0)}%`;

        console.log('\n' + '═'.repeat(56));
        console.log(`  🚀 OPENING TRADE`);
        console.log(`     Asset:       ${asset}`);
        console.log(`     Tick:        ${currentTick} (window: ${CONFIG.minEntryTick}–${CONFIG.maxEntryTick})`);
        console.log(`     Stake:       $${stake.toFixed(2)}`);
        console.log(`     Growth:      ${growthLabel}`);
        console.log(`     Take-Profit: $${takeProfitAmt.toFixed(2)} (${(CONFIG.takeProfitPct * 100).toFixed(0)}%)`);
        console.log(`     Regime:      ${signal.regime} | Score: ${(signal.score * 100).toFixed(1)}%`);
        console.log(`     RSI:         ${signal.rsi ? signal.rsi.toFixed(1) : 'N/A'} | BB pctile: ${signal.bbWidthPctile.toFixed(0)}`);
        console.log('═'.repeat(56));

        this._send({ buy: proposalId, price: stake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrade = {
            asset, currentTick, stake,
            takeProfitAmt, signal, proposalId,
            contractId: null,
            entryTime: Date.now(),
            growthRate: signal.growthRate,
        };

        this.notify(
            `🚀 <b>TRADE OPENED 3b</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Entry tick: ${currentTick}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Growth: ${growthLabel}\n` +
            `Take-Profit: $${takeProfitAmt.toFixed(2)}\n` +
            `Regime: ${signal.regime} | Score: ${(signal.score * 100).toFixed(1)}%\n` +
            `RSI: ${signal.rsi ? signal.rsi.toFixed(1) : 'N/A'} | BB pctile: ${signal.bbWidthPctile.toFixed(0)}`
        );
    }

    // ── Buy Response ──────────────────────────────────────────────────────────
    _handleBuy(msg) {
        if (msg.error) {
            console.error('❌ Buy error:', msg.error.message);
            this.tradeInProgress = false;
            this.activeTrade = null;
            this._clearWatchdogTimers();
            return;
        }

        const cid = msg.buy.contract_id;
        console.log(`✅ Contract opened: #${cid}`);

        if (this.activeTrade) this.activeTrade.contractId = cid;

        // Subscribe to live contract updates
        this._send({
            proposal_open_contract: 1,
            contract_id: cid,
            subscribe: 1,
        });

        // Record trade start time and start watchdog
        this.tradeStartTime = Date.now();
        if (this.activeTrade) this.activeTrade.entryTime = this.tradeStartTime;
        this._startTradeWatchdog(cid);
        console.log(`⏱️  Trade watchdog started (${(this.tradeWatchdogMs / 1000).toFixed(0)}s timeout)`);
    }

    // ── Contract Update (live monitoring) ─────────────────────────────────────
    _handleContractUpdate(msg) {
        if (msg.error) {
            console.error('Contract update error:', msg.error.message);
            return;
        }

        const contract = msg.proposal_open_contract;
        if (!contract || !this.activeTrade) return;

        // Save subscription ID for cleanup
        if (contract.id && !this.contractSubscriptionId) {
            this.contractSubscriptionId = contract.id;
        }

        // Contract settled?
        if (contract.is_sold) {
            this._handleTradeResult(contract);
            return;
        }

        const profit = parseFloat(contract.profit || 0);
        const bid = parseFloat(contract.bid_price || 0);
        const tickCount = contract.tick_count || 0;

        // Progress log every 2 ticks
        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(`📈 [${this.activeTrade.asset}] tick=${tickCount} | profit=$${profit.toFixed(3)} | bid=$${bid.toFixed(2)}`);
        }

        // Manual sell checks (in addition to the limit_order)
        if (contract.is_valid_to_sell) {
            const sell = this._shouldSell(contract, tickCount, profit);
            if (sell.yes) {
                console.log(`\n🎯 MANUAL SELL trigger: ${sell.reason}`);
                // this._send({ sell: contract.contract_id, price: bid.toFixed(2) });
            }
        }
    }

    _shouldSell(contract, tickCount, profit) {
        const tp = this.activeTrade?.takeProfitAmt || (CONFIG.initialStake * CONFIG.takeProfitPct);
        const stake = this.activeTrade?.stake || CONFIG.initialStake;

        // 1. Take profit fully reached (redundant with limit_order, but safe)
        if (profit >= tp)
            return { yes: true, reason: `take_profit_hit ($${profit.toFixed(3)})` };

        // 2. Early partial take at 70% of TP after 5 ticks
        if (tickCount >= 5 && profit >= tp * 0.70)
            return { yes: true, reason: `early_tp_70pct at tick ${tickCount}` };

        // 3. Hard stop on max hold ticks (rescue any remaining value)
        if (tickCount >= CONFIG.maxHoldTicks && profit > 0)
            return { yes: true, reason: `max_hold_ticks (${tickCount}) with profit` };

        // 4. Absolute max hold — exit regardless
        if (tickCount >= CONFIG.maxHoldTicks + 5)
            return { yes: true, reason: `absolute_max_hold (${tickCount})` };

        return { yes: false };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE WATCHDOG — DETECT AND RECOVER STUCK ACCUMULATOR CONTRACTS
    // ══════════════════════════════════════════════════════════════════════════
    // Accumulator contracts can sometimes get stuck (not settling after barrier
    // breach or not responding to sell orders). This watchdog monitors active
    // trades and forces recovery if they remain open beyond a reasonable time.

    _startTradeWatchdog(contractId) {
        this._clearWatchdogTimers();

        const timeoutMs = this.tradeWatchdogMs;

        this.tradeWatchdogTimer = setTimeout(() => {
            if (!this.tradeInProgress || !this.activeTrade) {
                this._clearWatchdogTimers();
                return;
            }

            console.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId || 'unknown'} has been open for ` +
                `${(timeoutMs / 1000).toFixed(0)}s with no settlement`
            );

            // Poll the contract to check its current status
            if (contractId && this.connected && this.wsReady) {
                console.log(`🔍 Polling contract ${contractId} for current status…`);
                this._send({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                });

                // Set a poll timeout — if we don't get a response, force recovery
                this.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!this.tradeInProgress) {
                        this._clearWatchdogTimers();
                        return;
                    }
                    console.error(
                        `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved, ` +
                        `force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, 15000); // 15 seconds for poll response

            } else {
                // WebSocket not connected — can't query, force recovery
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

    /**
     * Recover from a stuck trade — release the lock so the bot can trade again.
     * For Accumulator contracts, this handles scenarios where:
     *  - Contract never settles after barrier breach
     *  - Sell order never executes
     *  - proposal_open_contract stream stops responding
     */
    _recoverStuckTrade(reason) {
        this._clearWatchdogTimers();

        const contractId = this.activeTrade?.contractId || 'unknown';
        const asset = this.activeTrade?.asset || 'unknown';
        const stake = this.activeTrade?.stake || 0;
        const entryTime = this.activeTrade?.entryTime || this.tradeStartTime || Date.now();
        const openSeconds = Math.round((Date.now() - entryTime) / 1000);

        console.error(
            `\n🚨 STUCK TRADE RECOVERY [${reason}]` +
            `\n   Contract: ${contractId}` +
            `\n   Asset: ${asset}` +
            `\n   Stake: $${stake.toFixed(2)}` +
            `\n   Open for: ${openSeconds}s`
        );

        // Attempt to sell the contract if it's still valid (last-resort salvage)
        if (contractId && contractId !== 'unknown' && this.connected && this.wsReady) {
            console.log(`🔄 Attempting emergency sell of contract ${contractId}…`);
            this._send({
                sell: contractId,
                price: '0', // Sell at any available price
            });
        }

        // Forget contract subscription if it exists
        if (this.contractSubscriptionId) {
            this._send({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

        // Clear trade state so bot is not stuck
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.tradeStartTime = null;

        // Record as a loss (conservative — stake is likely lost)
        // this.totalLosses++;
        // this.consecutiveLosses++;
        // this.consecutiveLosses2++;
        // this.losttrades++;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].losses++;
            this.assetMetrics[asset].pnl -= stake;
        }

        this.totalPnl -= stake;
        this.dailyPnl -= stake;


        // Focus on the loss asset
        // this.suspendOtherAssets(asset);

        console.log(
            `\n   Trade lock released — bot can now trade again` +
            `\n   Stake $${stake.toFixed(2)} recorded as loss`
        );

        this.notify(
            `🚨 <b>STUCK TRADE RECOVERED [${reason}]</b>\n\n` +
            `Contract: ${contractId}\n` +
            `Asset: ${asset}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Open for: ${openSeconds}s\n` +
            `Action: Emergency sell attempted, trade lock released`
        );

        StatePersistence.save(this);
    }

    // ── Sell Response ────────────────────────────────────────────────────────
    _handleSell(msg) {
        if (msg.error) {
            console.error('❌ Sell error:', msg.error.message);
            return;
        }
        const sold = msg.sell?.sold_for || 0;
        console.log(`✅ Sold for $${sold}`);
    }

    // ── Trade Result ──────────────────────────────────────────────────────────
    _handleTradeResult(contract) {
        if (!this.activeTrade) {
            console.warn('Trade result received but no active trade!');
            this._clearWatchdogTimers();
            return;
        }

        // Clear watchdog — trade is settling normally
        this._clearWatchdogTimers();

        // Unsubscribe from contract
        if (this.contractSubscriptionId) {
            this._send({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

        const asset = contract.underlying || this.activeTrade.asset;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const tickCount = contract.tick_count || 0;

        // ── Update Stats ──────────────────────────────────────────────────────
        this.totalTrades++;
        this.totalPnl += profit;
        this.dailyPnl += profit;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].pnl += profit;
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.isWinTrade = true;
            this.currentStake = CONFIG.initialStake;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;

            // Asset-level cooldown
            this.riskManager.setAssetCooldown(asset);

            // If we were focused on a loss asset, resume all assets
            if (this.focusAsset) {
                this.resumeAllAssets();
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            if (this.consecutiveLosses < 2) {
                this.currentStake = Math.ceil(this.currentStake * this.multiplier * 100) / 100;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.multiplier2 * 100) / 100;
            }

            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            // Suspend all other assets and focus on this loss asset
            this.suspendOtherAssets(asset);

            // // Asset-level cooldown
            // this.riskManager.setAssetCooldown(asset);

            // Global pause if consecutive loss limit hit
            // if (this.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
            //     this.riskManager.setGlobalPause();
            //     // Reset counter so after pause we start clean
            //     this.consecutiveLosses = 0;
            // }
        }

        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';

        console.log('\n' + '═'.repeat(56));
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}  |  ${asset}  |  ${tickCount} ticks`);
        console.log(`  P&L:  ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`  Total P&L: $${this.totalPnl.toFixed(2)}  |  Win rate: ${winRate}%`);
        console.log('═'.repeat(56));

        this.notify(
            `${won ? '✅' : '❌'} <b>${won ? 'WIN' : 'LOSS'} (Bot 3b)</b>\n\n` +
            `Asset: <b>${asset}</b>  |  Ticks: ${tickCount}\n` +
            `${profit >= 0 ? '🟢' : '🔴'} P&amp;L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n` +
            `📊 Session:\n` +
            `trades: ${this.totalTrades} | ${this.totalWins}W/${this.totalLosses}L \n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Stake: $${this.currentStake.toFixed(2)} \n` +
            `WR: ${winRate}%\n` +
            `Total P&amp;L: $${this.totalPnl.toFixed(2)}`
        );

        // ── Stop conditions ───────────────────────────────────────────────────
        if (this.dailyPnl <= -CONFIG.maxDailyLoss || this.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
            this.shutdown(`daily_loss_limit ($${CONFIG.maxDailyLoss})`);
            this.sendHourlySummary();
            this.disconnect();
            return;
        }
        if (this.totalPnl >= CONFIG.takeProfitSession) {
            this.shutdown(`session_profit_target ($${CONFIG.takeProfitSession})`);
            this.sendHourlySummary();
            this.disconnect();
            return;
        }

        // ── Reset for next trade ──────────────────────────────────────────────
        this.tradeInProgress = false;
        this.activeTrade = null;

        StatePersistence.save(this);

        if (!won) {
            // ═══════════════════════════════════════════════════════════════════
            // IMMEDIATE RE-EVALUATION — Don't wait for the next tick to enter
            // the next trade. After a trade closes (especially after a loss),
            // the market regime may have shifted — we need to catch the new
            // trend immediately for effective recovery trading.
            // ═══════════════════════════════════════════════════════════════════
            this._evaluateAllAssetsImmediately();
        }
    }

    /**
     * Immediately evaluate all assets for a new trade opportunity.
     * Called right after a trade closes to avoid waiting for the next tick.
     * This is critical for recovery trades that need to enter quickly
     * after a trend reset.
     */
    _evaluateAllAssetsImmediately() {
        for (const asset of CONFIG.assets) {
            // Skip if asset is suspended
            if (!this.isAssetAllowed(asset)) continue;

            // Skip if already trading
            if (this.tradeInProgress) break;

            // Risk check
            const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
            if (!risk.allowed) continue;

            // Need enough history
            if (!this.tickPrices[asset] || this.tickPrices[asset].length < CONFIG.requiredHistory) continue;

            // Throttle check
            const now = Date.now();
            const lastAt = this.assetStates[asset].lastProposalAt || 0;
            // if ((now - lastAt) < CONFIG.proposalThrottleMs) continue;

            // Run analysis
            // const signal = this.analyzer.analyze(asset, this.tickPrices[asset]);
            // if (!signal.shouldEnter) continue;

            // After consecutive losses, skip weaker signals
            // if (this.consecutiveLosses < 1) {
            //     if (signal.growthRate < CONFIG.growthRateBoost) continue;
            // }

            console.log(`\n⚡ IMMEDIATE RE-ENTRY: ${asset} (post-trade evaluation)`);

            // All checks passed — execute trade immediately
            this.assetStates[asset].lastProposalAt = now;

            const takeProfitAmount = parseFloat((this.currentStake * CONFIG.takeProfitPct).toFixed(2));

            this._send({
                proposal: 1,
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'ACCU',
                currency: 'USD',
                symbol: asset,
                growth_rate: signal.growthRate,
                limit_order: {
                    take_profit: takeProfitAmount.toFixed(2),
                },
            });

            // Only enter one trade per re-evaluation
            break;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _log(asset, tick, msg) {
        // Compact single-line log for rejected proposals
        console.log(`  [${asset}] t=${tick} | ${msg}`);
    }

    _logAnalysis(asset, tick, signal, proposal) {
        const inWindow = tick >= CONFIG.minEntryTick && tick <= CONFIG.maxEntryTick;
        const lines = [
            `\n🔍 ${asset} @ tick ${tick} | window: ${inWindow ? '✅' : '❌'} | ${signal.shouldEnter ? '✅ ENTER' : '⏭  SKIP'}`,
            `   Regime: ${signal.regime.padEnd(16)} | Score: ${(signal.score * 100).toFixed(1)}%`,
            `   BB Squeeze pctile: ${signal.bbWidthPctile.toFixed(0).padStart(3)}% (need < ${CONFIG.bbSqueezePctile}%)`,
            `   RSI: ${signal.rsi ? signal.rsi.toFixed(1) : 'N/A'} (need ${CONFIG.rsiLow}–${CONFIG.rsiHigh})`,
            `   Momentum: ${signal.momentum ? (signal.momentum * 100).toFixed(4) + '%' : 'N/A'} (need < ${(CONFIG.maxPriceChangePct * 100).toFixed(3)}%)`,
            `   Growth: ${(signal.growthRate * 100).toFixed(0)}% | Reason: ${signal.reason}`,
        ];
        console.log(lines.join('\n'));
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async notify(html) {
        if (!this.telegram) return;
        try {
            await this.telegram.sendMessage(CONFIG.telegramChatId, html, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('Telegram error:', e.message);
        }
    }

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalPnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalPnl >= 0 ? '+' : '') + '$' + Math.abs(this.totalPnl).toFixed(2);

        await this.notify(
            `📊 <b>Session/Hourly Summary (Bot 3b)</b>\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `x2Losses: ${this.consecutiveLosses2}\n` +
            `x3Losses: ${this.consecutiveLosses3}\n` +
            `x4Losses: ${this.consecutiveLosses4}\n` +
            `x5Losses: ${this.consecutiveLosses5}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&amp;L: ${pnlStr}\n` +
            `Daily P&amp;L: ${this.dailyPnl >= 0 ? '+' : ''}$${this.dailyPnl.toFixed(2)}\n\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
        );
    }

    // ── Time-Based Disconnect / Reconnect ─────────────────────────────────────
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            // if (isWeekend) {
            //     if (!this.endOfDay) {
            //         console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
            //         this.sendHourlySummary();
            //         this.disconnect();
            //         this.endOfDay = true;
            //     }
            //     return; // Prevent any reconnection logic during the weekend
            // }

            //New Day trade Resumption
            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            //London Session Pause trading
            // if (this.isWinTrade && !this.endOfDay && currentHours < 10) {
            //     if (currentHours >= 6 && currentMinutes >= 0) {
            //         console.log("It's past 6:00 AM GMT+1 after a win trade, disconnecting the bot.");
            //         this.endOfDay = true;
            //         this.sendHourlySummary();
            //         this.disconnect();
            //     }
            // }

            // //London Session Trade Resumption
            // if (this.endOfDay && currentHours === 10 && currentMinutes >= 0) {
            //     console.log("It's 10:00 AM GMT+1, reconnecting the bot.");
            //     // this.resetForNewDay();
            //     this.endOfDay = false;
            //     this.connect();
            // }

            //New York Session Pause trading
            if (this.isWinTrade && !this.endOfDay && currentHours < 15) {
                if (currentHours >= 13 && currentMinutes >= 0) {
                    console.log("It's past 1:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.endOfDay = true;
                    this.sendHourlySummary();
                    this.disconnect();
                }
            }

            //New York Session Trade Resumption
            if (this.endOfDay && currentHours === 15 && currentMinutes >= 0) {
                console.log("It's 3:00 PM GMT+1, reconnecting the bot.");
                // this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            //End of Day trade Pause
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 11:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.endOfDay = true;
                    this.sendHourlySummary();
                    this.disconnect();
                }
            }
        }, 20000);
    }

    disconnect() {
        console.log('🛑 Disconnecting bot (time-based)...');
        StatePersistence.save(this);
        this.endOfDay = true;
        this._cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    resetForNewDay() {
        console.log('🌅 Resetting for new day...');
        this.dailyPnl = 0;
        this.consecutiveLosses = 0;
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.shutdownFlag = false;
        this.reconnectAttempts = 0;
        this.riskManager = new RiskManager();
        this._clearWatchdogTimers();
        // Clear asset suspension
        this.suspendedAssets.clear();
        this.focusAsset = null;
        console.log('✅ New day reset complete');
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    start() {
        const bar = '═'.repeat(56);
        console.log(`\n${bar}`);
        console.log('  DERIV RELIABLE ACCUMULATOR BOT  v4.0');
        console.log(bar);
        console.log(`  Assets:        ${CONFIG.assets.join(', ')}`);
        console.log(`  Stake:         $${CONFIG.initialStake.toFixed(2)}`);
        console.log(`  Growth Rate:   ${(CONFIG.growthRateDefault * 100).toFixed(0)}% → ${(CONFIG.growthRateBoost * 100).toFixed(0)}% adaptive`);
        console.log(`  Entry Window:  ticks ${CONFIG.minEntryTick}–${CONFIG.maxEntryTick}`);
        console.log(`  Take-Profit:   ${(CONFIG.takeProfitPct * 100).toFixed(0)}% of stake (limit order)`);
        console.log(`  BB Squeeze:    < ${CONFIG.bbSqueezePctile}th percentile`);
        console.log(`  RSI Filter:    ${CONFIG.rsiLow}–${CONFIG.rsiHigh}`);
        console.log(`  Max Daily Loss: $${CONFIG.maxDailyLoss}`);
        console.log(`  Session TP:    $${CONFIG.takeProfitSession}`);
        console.log(`${bar}\n`);

        // Auto-save state
        this._saveInterval = StatePersistence.autoSave(this);

        // Graceful shutdown hooks
        const exit = () => {
            console.log('\n🛑 Shutdown requested...');
            StatePersistence.save(this);
            process.exit(0);
        };
        process.on('SIGINT', exit);
        process.on('SIGTERM', exit);
        process.on('uncaughtException', (err) => {
            console.error('💥 Uncaught exception:', err);
            StatePersistence.save(this);
            process.exit(1);
        });

        this.connect();
        this.checkTimeForDisconnectReconnect();

        this.notify(
            `🤖 <b>Accumulator Bot v4.0 Started 3b</b>\n\n` +
            `Assets: ${CONFIG.assets.join(', ')}\n` +
            `Stake: $${CONFIG.initialStake.toFixed(2)} | Growth: ${(CONFIG.growthRateDefault * 100).toFixed(0)}%–${(CONFIG.growthRateBoost * 100).toFixed(0)}%\n` +
            `Entry window: ticks ${CONFIG.minEntryTick}–${CONFIG.maxEntryTick}\n` +
            `Strategy: BB Squeeze + RSI Filter`
        );
    }

    shutdown(reason = 'manual') {
        console.log(`\n🛑 Shutting down — ${reason}`);
        this.shutdownFlag = true;
        if (this._saveInterval) clearInterval(this._saveInterval);
        StatePersistence.save(this);

        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';

        this.notify(
            `🛑 <b>Bot Shutdown 3b</b>\n\n` +
            `Reason: ${reason}\n\n` +
            `Final Stats:\n` +
            `Trades: ${this.totalTrades} | WR: ${winRate}%\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Total P&amp;L: $${this.totalPnl.toFixed(2)}`
        );

        this._cleanup();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new ReliableAccumulatorBot();
bot.start();

module.exports = { ReliableAccumulatorBot };
