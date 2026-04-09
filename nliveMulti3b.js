/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        DERIV RELIABLE ACCUMULATOR BOT  v4.1                 ║
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
 * ║                                                              ║
 * ║  v4.1 CHANGES:                                              ║
 * ║  • Instant recovery proposal — pre-fetched BEFORE trade      ║
 * ║    settles using a shadow proposal pipeline                  ║
 * ║  • Trade lock released immediately on is_sold detection      ║
 * ║  • Recovery bypass: skips throttle + signal gate on          ║
 * ║    first recovery trade after a loss                         ║
 * ║  • Proposal cache: stores ready proposals per asset          ║
 * ║  • Tick-independent recovery: fires on ws message receipt    ║
 * ║    not on the next tick arrival                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
    // Deriv API
    token: '0P94g4WdSrSrzir',
    appId: 1089,
    wsUrl: 'wss://ws.derivws.com/websockets/v3',

    // Assets to trade (ordered by preference)
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    // Staking (FLAT — no Martingale)
    initialStake: 1.00,
    multiplier: 6.00,
    multiplier2: 8.00,

    // Growth rates
    growthRateDefault: 0.01,
    growthRateBoost: 0.02,

    // Entry window
    minEntryTick: 0,
    maxEntryTick: 10,

    // Take-profit
    takeProfitPct: 0.20,
    maxHoldTicks: 20,

    // Bollinger Bands
    bbPeriod: 20,
    bbMultiplier: 2.0,
    bbSqueezePctile: 20,

    // RSI
    rsiPeriod: 14,
    rsiLow: 40,
    rsiHigh: 60,

    // Momentum
    maxPriceChangePct: 0.002,

    // Min history required before analysis
    requiredHistory: 60,

    // Risk management
    maxConsecutiveLosses: 3,
    consecutiveLossCooldownMs: 1800000,
    assetCooldownMs: 1800000,
    maxDailyLoss: 500,
    takeProfitSession: 50000,

    // ── v4.1: Recovery settings ───────────────────────────────────────────────
    // Throttle is bypassed for the FIRST recovery trade after a loss.
    // After that, normal throttle resumes.
    proposalThrottleMs: 10000,          // normal throttle (ms)
    recoveryProposalThrottleMs: 500,    // ultra-fast throttle during recovery
    recoveryMode: true,                 // enable instant recovery
    recoveryBypassSignalGate: true,     // bypass BB/RSI gate on recovery trade
    // Shadow proposal: prefetch proposals for focus asset while trade is live
    shadowProposalIntervalMs: 3000,     // how often to refresh shadow proposal

    // Telegram
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',

    // State persistence
    stateFile: path.join(__dirname, 'accumulator_botB07_state.json'),
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
// VOLATILITY ANALYZER
// ─────────────────────────────────────────────────────────────────────────────
class VolatilityAnalyzer {
    constructor() {
        this.bbWidthHistory = {};
    }

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
            width: (2 * mult * sigma) / mean,
            sigma,
            mean,
        };
    }

    computeRSI(prices, period = CONFIG.rsiPeriod) {
        if (prices.length < period + 1) return null;
        const changes = [];
        for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
        const recent = changes.slice(-period);
        let gains = 0, losses = 0;
        recent.forEach(c => { if (c > 0) gains += c; else losses -= c; });
        let avgGain = gains / period;
        let avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }

    computeMomentum(prices, lookback = 10) {
        if (prices.length < lookback + 1) return null;
        const slice = prices.slice(-lookback - 1);
        let sumAbsPctChange = 0;
        for (let i = 1; i < slice.length; i++) {
            sumAbsPctChange += Math.abs((slice[i] - slice[i - 1]) / slice[i - 1]);
        }
        return sumAbsPctChange / lookback;
    }

    getBBWidthPercentile(asset, currentWidth) {
        if (!this.bbWidthHistory[asset]) this.bbWidthHistory[asset] = [];
        const history = this.bbWidthHistory[asset];
        history.push(currentWidth);
        if (history.length > 100) history.shift();
        if (history.length < 20) return 50;
        const sorted = [...history].sort((a, b) => a - b);
        const rank = sorted.filter(w => w <= currentWidth).length;
        return (rank / sorted.length) * 100;
    }

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

        let bbScore = 1 - (bbWidthPctile / 100);
        bbScore = Math.pow(bbScore, 0.7);

        const rsiCentre = 50;
        const rsiDist = Math.abs(rsi - rsiCentre);
        const rsiScore = Math.max(0, 1 - rsiDist / 40);

        const momentumThreshold = CONFIG.maxPriceChangePct;
        const momentumScore = Math.max(0, 1 - momentum / (momentumThreshold * 3));

        const score = (bbScore * 0.55 + rsiScore * 0.30 + momentumScore * 0.15);

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

        const strongSqueeze = bbWidthPctile < 20;
        const rsiCentred = rsi >= 44 && rsi <= 56;
        const growthRate = (strongSqueeze && rsiCentred && shouldEnter)
            ? CONFIG.growthRateBoost
            : CONFIG.growthRateDefault;

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
        this.assetCooldowns = {};
        this.globalPausedUntil = 0;
    }

    setAssetCooldown(asset) {
        this.assetCooldowns[asset] = Date.now() + CONFIG.assetCooldownMs;
        const mins = (CONFIG.assetCooldownMs / 60000).toFixed(0);
        console.log(`🔒 ${asset} cooldown for ${mins} min`);
    }

    isAssetOnCooldown(asset) {
        return Date.now() < (this.assetCooldowns[asset] || 0);
    }

    assetCooldownRemaining(asset) {
        return Math.max(0, (this.assetCooldowns[asset] || 0) - Date.now());
    }

    setGlobalPause() {
        this.globalPausedUntil = Date.now() + CONFIG.consecutiveLossCooldownMs;
        const mins = (CONFIG.consecutiveLossCooldownMs / 60000).toFixed(0);
        console.log(`⏸️  Global pause for ${mins} min`);
    }

    isGloballyPaused() {
        return Date.now() < this.globalPausedUntil;
    }

    canTrade(asset, dailyPnl, consecutiveLosses) {
        if (dailyPnl <= -CONFIG.maxDailyLoss)
            return { allowed: false, reason: `daily_loss_limit ($${CONFIG.maxDailyLoss})` };
        if (this.isGloballyPaused()) {
            const remMin = ((this.globalPausedUntil - Date.now()) / 60000).toFixed(0);
            return { allowed: false, reason: `global_pause (${remMin}m remaining)` };
        }
        if (consecutiveLosses >= CONFIG.maxConsecutiveLosses)
            return { allowed: false, reason: `consecutive_loss_limit (${consecutiveLosses}/${CONFIG.maxConsecutiveLosses})` };
        if (this.isAssetOnCooldown(asset)) {
            const remMin = (this.assetCooldownRemaining(asset) / 60000).toFixed(0);
            return { allowed: false, reason: `asset_cooldown (${remMin}m remaining)` };
        }
        return { allowed: true };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPOSAL CACHE — stores ready proposals keyed by asset
// ─────────────────────────────────────────────────────────────────────────────
class ProposalCache {
    constructor() {
        // { asset: { proposalId, proposal, signal, cachedAt, ticks } }
        this.cache = {};
        // Max age of a cached proposal before it's considered stale (ms)
        // Deriv proposals expire after ~60s; keep it well under that
        this.maxAgeMs = 25000;
    }

    set(asset, proposalId, proposal, signal, ticks) {
        this.cache[asset] = {
            proposalId,
            proposal,
            signal,
            ticks,
            cachedAt: Date.now(),
        };
    }

    get(asset) {
        const entry = this.cache[asset];
        if (!entry) return null;
        if (Date.now() - entry.cachedAt > this.maxAgeMs) {
            delete this.cache[asset];
            return null;
        }
        return entry;
    }

    invalidate(asset) {
        delete this.cache[asset];
    }

    invalidateAll() {
        this.cache = {};
    }

    isValid(asset) {
        return this.get(asset) !== null;
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

        // Price history
        this.tickPrices = {};
        this.tickSubscriptionIds = {};

        // Per-asset state
        this.assetStates = {};
        this.lastProposalAt = {};

        // Active trade tracking
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.contractSubscriptionId = null;

        // ── v4.1: Recovery pipeline ───────────────────────────────────────────
        // Tracks whether the NEXT trade is a recovery trade (first after a loss)
        this.isRecoveryMode = false;
        // Proposal cache — stores ready-to-fire proposals
        this.proposalCache = new ProposalCache();
        // Shadow proposal timer — refreshes proposals for focus asset while
        // a live trade is running, so recovery can fire instantly on settlement
        this.shadowProposalTimer = null;
        // Pending recovery execution — set when a result arrives and we have
        // a cached proposal ready to fire immediately
        this.pendingRecovery = null;
        // Tracks proposals currently in-flight (to prevent duplicate requests)
        this.proposalInFlight = {};
        // ─────────────────────────────────────────────────────────────────────

        // Trade Watchdog
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000;
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
        this.suspendedAssets = new Set();
        this.focusAsset = null;

        // Telegram
        this.telegram = (CONFIG.telegramToken && CONFIG.telegramChatId)
            ? new TelegramBot(CONFIG.telegramToken, { polling: false })
            : null;

        // Init per-asset structures
        CONFIG.assets.forEach(asset => {
            this.tickPrices[asset] = [];
            this.assetStates[asset] = { proposalId: null, lastTicks: 0, lastProposalAt: 0 };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
            this.proposalInFlight[asset] = false;
        });

        this._loadState();
        this._startTelegramTimer();
    }

    // ── Asset Suspension Logic ────────────────────────────────────────────────
    suspendOtherAssets(lossAsset) {
        this.focusAsset = lossAsset;
        CONFIG.assets.forEach(asset => {
            if (asset !== lossAsset) this.suspendedAssets.add(asset);
        });
        console.log(`🔒 SUSPENDED: All assets except ${lossAsset}. Focusing on loss asset.`);
        this.notify(
            `🔒 <b>Asset Suspension (Bot 3b)</b>\n\n` +
            `Loss on: <b>${lossAsset}</b>\n` +
            `Suspended: ${CONFIG.assets.filter(a => a !== lossAsset).join(', ')}\n` +
            `Focusing on ${lossAsset} until win`
        );
    }

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

    isAssetAllowed(asset) {
        if (!this.focusAsset) return true;
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
        this._stopShadowProposalTimer();
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
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: 200,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    // ── History ───────────────────────────────────────────────────────────────
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
            this.tickSubscriptionIds[msg.tick.symbol] = msg.subscription.id;
        }

        const { symbol, quote } = msg.tick;
        const price = Number(quote);
        const prices = this.tickPrices[symbol];
        if (!prices) return;

        prices.push(price);
        while (prices.length > 300) prices.shift();

        // Normal proposal request (throttled)
        this._maybeRequestProposal(symbol);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v4.1 — SHADOW PROPOSAL PIPELINE
    //
    // While a trade is LIVE, we silently prefetch and refresh proposals for
    // the focus asset (or best available asset). When the live trade settles,
    // _handleTradeResult releases the lock and IMMEDIATELY calls
    // _fireRecoveryTrade() which executes the pre-cached proposal without
    // waiting for the next tick or throttle.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start fetching shadow proposals for a given asset while a trade is live.
     * The shadow proposals are stored in the proposal cache so they are
     * immediately available when the live trade ends.
     */
    _startShadowProposalTimer(asset) {
        this._stopShadowProposalTimer();

        console.log(`🌑 Shadow proposal pipeline started for ${asset}`);

        // Fire immediately then repeat
        this._fetchShadowProposal(asset);

        this.shadowProposalTimer = setInterval(() => {
            // Stop if trade is no longer in progress (settled)
            if (!this.tradeInProgress) {
                this._stopShadowProposalTimer();
                return;
            }
            this._fetchShadowProposal(asset);
        }, CONFIG.shadowProposalIntervalMs);
    }

    _stopShadowProposalTimer() {
        if (this.shadowProposalTimer) {
            clearInterval(this.shadowProposalTimer);
            this.shadowProposalTimer = null;
        }
    }

    /**
     * Request a shadow proposal for an asset.
     * Tagged with shadow: true in the passthrough so _handleProposal knows
     * to cache it rather than immediately executing a trade.
     */
    _fetchShadowProposal(asset) {
        if (!this.wsReady || !this.connected) return;
        if (this.proposalInFlight[asset]) return; // don't stack requests

        const prices = this.tickPrices[asset];
        if (!prices || prices.length < CONFIG.requiredHistory) return;

        // Analyze signal — even for recovery we want a rough picture
        const signal = this.analyzer.analyze(asset, prices);
        const growthRate = signal.growthRate || CONFIG.growthRateDefault;
        const takeProfitAmount = parseFloat(
            (this.currentStake * CONFIG.takeProfitPct).toFixed(2)
        );

        this.proposalInFlight[asset] = true;

        const sent = this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: growthRate,
            limit_order: {
                take_profit: takeProfitAmount.toFixed(2),
            },
            // passthrough is echoed back in the response — we use it to
            // identify shadow proposals vs. normal proposals
            passthrough: { shadow: true, shadowAsset: asset },
        });

        if (!sent) this.proposalInFlight[asset] = false;
    }

    /**
     * Main proposal request — throttled, gated by signal analysis.
     * Used during normal (non-recovery) trading.
     */
    _maybeRequestProposal(asset) {
        if (this.tradeInProgress) return;
        if (!this.wsReady) return;
        if (this.shutdownFlag) return;
        if (!this.isAssetAllowed(asset)) return;

        const now = Date.now();
        const lastAt = this.assetStates[asset].lastProposalAt || 0;

        // Use fast throttle during recovery, normal throttle otherwise
        const throttleMs = this.isRecoveryMode
            ? CONFIG.recoveryProposalThrottleMs
            : CONFIG.proposalThrottleMs;

        if ((now - lastAt) < throttleMs) return;
        if (this.tickPrices[asset].length < CONFIG.requiredHistory) return;

        const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
        if (!risk.allowed) return;

        // Signal gate — bypassed for recovery if configured
        const signal = this.analyzer.analyze(asset, this.tickPrices[asset]);
        const bypassSignal = this.isRecoveryMode && CONFIG.recoveryBypassSignalGate;

        if (!bypassSignal && !signal.shouldEnter) return;

        if (this.proposalInFlight[asset]) return;

        this.assetStates[asset].lastProposalAt = now;
        this.proposalInFlight[asset] = true;

        const takeProfitAmount = parseFloat(
            (this.currentStake * CONFIG.takeProfitPct).toFixed(2)
        );

        const sent = this._send({
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
            passthrough: { shadow: false, shadowAsset: asset },
        });

        if (!sent) this.proposalInFlight[asset] = false;
    }

    // ── Proposal Handler ──────────────────────────────────────────────────────
    _handleProposal(msg) {
        // Always clear in-flight flag
        const asset = msg.echo_req?.symbol || msg.echo_req?.passthrough?.shadowAsset;
        if (asset) this.proposalInFlight[asset] = false;

        if (msg.error) {
            if (msg.error.code !== 'ContractBuyValidationError') {
                console.log(`Proposal error [${asset}]: ${msg.error.message}`);
            }
            return;
        }

        if (!msg.proposal) return;

        const proposal = msg.proposal;
        const isShadow = msg.echo_req?.passthrough?.shadow === true;

        // Validate proposal has required fields
        if (!proposal.contract_details || !proposal.contract_details.ticks_stayed_in) return;

        const stayedIn = proposal.contract_details.ticks_stayed_in;
        const currentTick = (stayedIn[stayedIn.length - 1] || 0) + 1;

        // Re-run signal analysis with latest prices
        const prices = this.tickPrices[asset] || [];
        const signal = this.analyzer.analyze(asset, prices);

        // ── SHADOW PROPOSAL: store in cache only ─────────────────────────────
        if (isShadow) {
            this.proposalCache.set(asset, proposal.id, proposal, signal, currentTick);
            console.log(
                `🌑 Shadow proposal cached for ${asset} ` +
                `(tick=${currentTick}, id=${proposal.id.substring(0, 8)}…)`
            );

            // If we have a pending recovery waiting for a proposal, fire it now
            if (this.pendingRecovery && this.pendingRecovery.asset === asset) {
                console.log(`⚡ Pending recovery found — firing immediately from shadow cache`);
                const recovery = this.pendingRecovery;
                this.pendingRecovery = null;
                setImmediate(() => this._fireRecoveryTrade(recovery.asset));
            }
            return;
        }

        // ── NORMAL PROPOSAL ──────────────────────────────────────────────────
        this.assetStates[asset].proposalId = proposal.id;

        // Also cache normal proposals (they can serve as recovery proposals too)
        this.proposalCache.set(asset, proposal.id, proposal, signal, currentTick);

        this._logAnalysis(asset, currentTick, signal, proposal);

        // Don't trade if already trading
        if (this.tradeInProgress) return;

        // ── Recovery mode: use relaxed gating ────────────────────────────────
        if (this.isRecoveryMode) {
            const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
            if (!risk.allowed) {
                this._log(asset, currentTick, `🚫 Risk block: ${risk.reason}`);
                return;
            }
            console.log(`⚡ RECOVERY MODE — executing immediately on ${asset} tick=${currentTick}`);
            this._executeTrade(asset, proposal, signal, currentTick);
            return;
        }

        // ── Normal mode gating ────────────────────────────────────────────────
        if (this.consecutiveLosses < 1) {
            if (currentTick < CONFIG.minEntryTick) {
                this._log(asset, currentTick, `⏳ Too early (${currentTick}<${CONFIG.minEntryTick})`);
                return;
            }
            if (currentTick > CONFIG.maxEntryTick) {
                this._log(asset, currentTick, `⏰ Too late (${currentTick}>${CONFIG.maxEntryTick})`);
                return;
            }

            const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
            if (!risk.allowed) {
                this._log(asset, currentTick, `🚫 Risk block: ${risk.reason}`);
                return;
            }

            if (signal.growthRate < CONFIG.growthRateBoost) return;

            if (signal.shouldEnter) {
                this._executeTrade(asset, proposal, signal, currentTick);
            }
        } else {
            this._executeTrade(asset, proposal, signal, currentTick);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v4.1 — INSTANT RECOVERY TRADE EXECUTOR
    //
    // Called by _handleTradeResult after a LOSS. Attempts to fire a trade
    // immediately using a pre-cached proposal. If no cached proposal is
    // available yet, sets a pendingRecovery so the next shadow proposal
    // response triggers it.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt to fire a recovery trade immediately using the proposal cache.
     * If cache is empty, registers a pending recovery so the next shadow
     * proposal response fires it.
     *
     * @param {string} asset - The focus asset to recover on
     */
    _fireRecoveryTrade(asset) {
        if (this.tradeInProgress) return;
        if (this.shutdownFlag) return;
        if (!this.wsReady || !this.connected) return;

        const risk = this.riskManager.canTrade(asset, this.dailyPnl, this.consecutiveLosses);
        if (!risk.allowed) {
            console.log(`🚫 Recovery blocked by risk: ${risk.reason}`);
            this.isRecoveryMode = false;
            return;
        }

        const cached = this.proposalCache.get(asset);

        if (cached) {
            console.log(
                `\n⚡ INSTANT RECOVERY TRADE` +
                `\n   Asset: ${asset}` +
                `\n   Proposal: ${cached.proposalId.substring(0, 12)}…` +
                `\n   Cached: ${((Date.now() - cached.cachedAt) / 1000).toFixed(1)}s ago` +
                `\n   Tick: ${cached.ticks}`
            );

            // Invalidate cache entry so it's not reused
            this.proposalCache.invalidate(asset);

            // Execute immediately
            this._executeTrade(asset, cached.proposal, cached.signal, cached.ticks);

        } else {
            // No cached proposal yet — register pending recovery and request one now
            console.log(
                `⚡ Recovery: no cached proposal for ${asset} — ` +
                `registering pending recovery and requesting fresh proposal`
            );

            this.pendingRecovery = { asset, requestedAt: Date.now() };

            // Request a shadow proposal immediately (bypass throttle)
            this.proposalInFlight[asset] = false; // clear any stale in-flight flag
            this._fetchShadowProposal(asset);

            // Fallback: if shadow proposal takes too long, force a direct request
            setTimeout(() => {
                if (!this.pendingRecovery) return; // already handled
                if (this.tradeInProgress) {
                    this.pendingRecovery = null;
                    return;
                }
                console.log(`⚡ Recovery fallback — forcing direct proposal request for ${asset}`);
                this.pendingRecovery = null;
                this.isRecoveryMode = true;
                // Reset throttle timestamp so _maybeRequestProposal fires immediately
                this.assetStates[asset].lastProposalAt = 0;
                this.proposalInFlight[asset] = false;
                this._maybeRequestProposal(asset);
            }, 2000); // 2 second fallback window
        }
    }

    // ── Trade Execution ───────────────────────────────────────────────────────
    _executeTrade(asset, proposal, signal, currentTick) {
        const proposalId = proposal.id || this.assetStates[asset].proposalId;
        if (!proposalId) {
            console.error(`❌ No proposal ID for ${asset}`);
            return;
        }

        // Double-check we're not already in a trade (race condition guard)
        if (this.tradeInProgress) {
            console.warn(`⚠️  _executeTrade called but trade already in progress — skipping`);
            return;
        }

        const stake = this.currentStake;
        const takeProfitAmt = parseFloat((stake * CONFIG.takeProfitPct).toFixed(2));
        const growthLabel = `${(signal.growthRate * 100).toFixed(0)}%`;
        const modeLabel = this.isRecoveryMode ? '⚡ RECOVERY' : '🚀 TRADE';

        console.log('\n' + '═'.repeat(56));
        console.log(`  ${modeLabel} OPENED`);
        console.log(`     Asset:       ${asset}`);
        console.log(`     Tick:        ${currentTick}`);
        console.log(`     Stake:       $${stake.toFixed(2)}`);
        console.log(`     Growth:      ${growthLabel}`);
        console.log(`     Take-Profit: $${takeProfitAmt.toFixed(2)} (${(CONFIG.takeProfitPct * 100).toFixed(0)}%)`);
        console.log(`     Regime:      ${signal.regime} | Score: ${(signal.score * 100).toFixed(1)}%`);
        console.log(`     RSI:         ${signal.rsi ? signal.rsi.toFixed(1) : 'N/A'} | BB pctile: ${signal.bbWidthPctile.toFixed(0)}`);
        if (this.isRecoveryMode) console.log(`     Mode:        ⚡ INSTANT RECOVERY`);
        console.log('═'.repeat(56));

        // Set trade lock BEFORE sending buy to prevent race conditions
        this.tradeInProgress = true;
        this.activeTrade = {
            asset, currentTick, stake,
            takeProfitAmt, signal, proposalId,
            contractId: null,
            entryTime: Date.now(),
            growthRate: signal.growthRate,
            isRecovery: this.isRecoveryMode,
        };

        // Clear recovery mode now that we're entering
        this.isRecoveryMode = false;
        this.pendingRecovery = null;

        this._send({ buy: proposalId, price: stake.toFixed(2) });

        this.notify(
            `${this.activeTrade.isRecovery ? '⚡' : '🚀'} <b>${this.activeTrade.isRecovery ? 'RECOVERY TRADE' : 'TRADE OPENED'} 3b</b>\n\n` +
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

            // ── v4.1: If buy fails during recovery, release lock and retry ──
            const wasRecovery = this.activeTrade?.isRecovery || false;
            const asset = this.activeTrade?.asset;

            this.tradeInProgress = false;
            this.activeTrade = null;
            this._clearWatchdogTimers();

            // If the buy error is a stale proposal, immediately fetch a new one
            if (wasRecovery && asset) {
                console.log(`⚡ Recovery buy failed — requesting fresh proposal for ${asset}`);
                this.isRecoveryMode = true;
                this.proposalInFlight[asset] = false;
                this.assetStates[asset].lastProposalAt = 0;
                // Small delay to avoid hammering the API
                setTimeout(() => this._maybeRequestProposal(asset), 300);
            }
            return;
        }

        const cid = msg.buy.contract_id;
        console.log(`✅ Contract opened: #${cid}`);

        if (this.activeTrade) this.activeTrade.contractId = cid;

        this._send({
            proposal_open_contract: 1,
            contract_id: cid,
            subscribe: 1,
        });

        this.tradeStartTime = Date.now();
        if (this.activeTrade) this.activeTrade.entryTime = this.tradeStartTime;
        this._startTradeWatchdog(cid);

        // ── v4.1: Start shadow proposal pipeline for focus/current asset ────
        // This ensures that while this trade is live, we are already
        // prefetching the next proposal so recovery is instant.
        const shadowAsset = this.focusAsset || this.activeTrade?.asset;
        if (shadowAsset && CONFIG.recoveryMode) {
            this._startShadowProposalTimer(shadowAsset);
        }
    }

    // ── Contract Update ───────────────────────────────────────────────────────
    _handleContractUpdate(msg) {
        if (msg.error) {
            console.error('Contract update error:', msg.error.message);
            return;
        }

        const contract = msg.proposal_open_contract;
        if (!contract || !this.activeTrade) return;

        if (contract.id && !this.contractSubscriptionId) {
            this.contractSubscriptionId = contract.id;
        }

        // ── v4.1: Release lock IMMEDIATELY on is_sold ────────────────────────
        // Previously this called _handleTradeResult which did stats + notify
        // BEFORE releasing the lock. Now we release first, then do bookkeeping.
        if (contract.is_sold) {
            this._handleTradeResult(contract);
            return;
        }

        const profit = parseFloat(contract.profit || 0);
        const bid = parseFloat(contract.bid_price || 0);
        const tickCount = contract.tick_count || 0;

        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(
                `📈 [${this.activeTrade.asset}] tick=${tickCount} | ` +
                `profit=$${profit.toFixed(3)} | bid=$${bid.toFixed(2)}`
            );
        }

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

        if (profit >= tp)
            return { yes: true, reason: `take_profit_hit ($${profit.toFixed(3)})` };
        if (tickCount >= 5 && profit >= tp * 0.70)
            return { yes: true, reason: `early_tp_70pct at tick ${tickCount}` };
        if (tickCount >= CONFIG.maxHoldTicks && profit > 0)
            return { yes: true, reason: `max_hold_ticks (${tickCount}) with profit` };
        if (tickCount >= CONFIG.maxHoldTicks + 5)
            return { yes: true, reason: `absolute_max_hold (${tickCount})` };

        return { yes: false };
    }

    // ── Trade Watchdog ────────────────────────────────────────────────────────
    _startTradeWatchdog(contractId) {
        this._clearWatchdogTimers();

        this.tradeWatchdogTimer = setTimeout(() => {
            if (!this.tradeInProgress || !this.activeTrade) {
                this._clearWatchdogTimers();
                return;
            }

            console.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId || 'unknown'} has been open for ` +
                `${(this.tradeWatchdogMs / 1000).toFixed(0)}s with no settlement`
            );

            if (contractId && this.connected && this.wsReady) {
                this._send({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                });

                this.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!this.tradeInProgress) {
                        this._clearWatchdogTimers();
                        return;
                    }
                    console.error(`🚨 WATCHDOG: Poll timed out — force-releasing lock`);
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);
            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, this.tradeWatchdogMs);
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
        this._stopShadowProposalTimer();

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

        if (contractId !== 'unknown' && this.connected && this.wsReady) {
            this._send({ sell: contractId, price: '0' });
        }

        if (this.contractSubscriptionId) {
            this._send({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

        // Release lock immediately
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.tradeStartTime = null;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].losses++;
            this.assetMetrics[asset].pnl -= stake;
        }
        this.totalPnl -= stake;
        this.dailyPnl -= stake;

        console.log(`\n   Trade lock released — bot can now trade again`);

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

    // ── Sell Response ─────────────────────────────────────────────────────────
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

        // ── v4.1: RELEASE TRADE LOCK IMMEDIATELY ─────────────────────────────
        // This is the critical fix — we capture all trade data first, then
        // release the lock so the bot can accept new proposals/buy commands
        // while we do bookkeeping (stats, Telegram) asynchronously.
        const tradeSnapshot = { ...this.activeTrade };
        const asset = contract.underlying || tradeSnapshot.asset;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const tickCount = contract.tick_count || 0;

        // ⬇️ LOCK RELEASED HERE — before any async work
        this.tradeInProgress = false;
        this.activeTrade = null;

        // Clear timers
        this._clearWatchdogTimers();
        this._stopShadowProposalTimer();

        // Unsubscribe from contract
        if (this.contractSubscriptionId) {
            this._send({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

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
            this.isRecoveryMode = false;
            this.pendingRecovery = null;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;
            this.riskManager.setAssetCooldown(asset);
            if (this.focusAsset) this.resumeAllAssets();

        } else {
            // ── LOSS HANDLING ─────────────────────────────────────────────────
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

            // Suspend other assets and focus on the loss asset
            this.suspendOtherAssets(asset);

            // ── v4.1: TRIGGER INSTANT RECOVERY ───────────────────────────────
            // Set recovery mode flag BEFORE calling _fireRecoveryTrade so that
            // any proposal handler that fires knows to bypass signal gates.
            if (CONFIG.recoveryMode) {
                this.isRecoveryMode = true;
                // Use setImmediate to ensure lock is fully released before
                // we attempt to enter a new trade (prevents same-tick re-entry
                // on win condition false-positives)
                setImmediate(() => this._fireRecoveryTrade(asset));
            }
        }

        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';

        console.log('\n' + '═'.repeat(56));
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}  |  ${asset}  |  ${tickCount} ticks`);
        console.log(`  P&L:  ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`  Total P&L: $${this.totalPnl.toFixed(2)}  |  Win rate: ${winRate}%`);
        if (!won) console.log(`  ⚡ Recovery trade queued for ${asset}`);
        console.log('═'.repeat(56));

        // Telegram notify (async — does not block trade execution)
        this.notify(
            `${won ? '✅' : '❌'} <b>${won ? 'WIN' : 'LOSS'} (Bot 3b)</b>\n\n` +
            `Asset: <b>${asset}</b>  |  Ticks: ${tickCount}\n` +
            `${profit >= 0 ? '🟢' : '🔴'} P&amp;L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n` +
            `📊 Session:\n` +
            `trades: ${this.totalTrades} | ${this.totalWins}W/${this.totalLosses}L \n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Stake: $${this.currentStake.toFixed(2)} \n` +
            `WR: ${winRate}%\n` +
            `Total P&amp;L: $${this.totalPnl.toFixed(2)}` +
            (!won ? `\n⚡ Recovery trade queued` : '')
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

        StatePersistence.save(this);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _log(asset, tick, msg) {
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

    _startTelegramTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    // ── Time-Based Disconnect / Reconnect ─────────────────────────────────────
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay && currentHours < 15) {
                if (currentHours >= 13 && currentMinutes >= 0) {
                    console.log("It's past 1:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.endOfDay = true;
                    this.sendHourlySummary();
                    this.disconnect();
                }
            }

            if (this.endOfDay && currentHours === 15 && currentMinutes >= 0) {
                console.log("It's 3:00 PM GMT+1, reconnecting the bot.");
                this.endOfDay = false;
                this.connect();
            }

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
        console.log('🛑 Disconnecting bot...');
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
        this.isRecoveryMode = false;
        this.pendingRecovery = null;
        this.proposalCache.invalidateAll();
        this.riskManager = new RiskManager();
        this._clearWatchdogTimers();
        this._stopShadowProposalTimer();
        this.suspendedAssets.clear();
        this.focusAsset = null;
        CONFIG.assets.forEach(a => { this.proposalInFlight[a] = false; });
        console.log('✅ New day reset complete');
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    start() {
        const bar = '═'.repeat(56);
        console.log(`\n${bar}`);
        console.log('  DERIV RELIABLE ACCUMULATOR BOT  v4.1');
        console.log(bar);
        console.log(`  Assets:        ${CONFIG.assets.join(', ')}`);
        console.log(`  Stake:         $${CONFIG.initialStake.toFixed(2)}`);
        console.log(`  Growth Rate:   ${(CONFIG.growthRateDefault * 100).toFixed(0)}% → ${(CONFIG.growthRateBoost * 100).toFixed(0)}% adaptive`);
        console.log(`  Entry Window:  ticks ${CONFIG.minEntryTick}–${CONFIG.maxEntryTick}`);
        console.log(`  Take-Profit:   ${(CONFIG.takeProfitPct * 100).toFixed(0)}% of stake`);
        console.log(`  BB Squeeze:    < ${CONFIG.bbSqueezePctile}th percentile`);
        console.log(`  RSI Filter:    ${CONFIG.rsiLow}–${CONFIG.rsiHigh}`);
        console.log(`  Max Daily Loss: $${CONFIG.maxDailyLoss}`);
        console.log(`  Session TP:    $${CONFIG.takeProfitSession}`);
        console.log(`  Recovery Mode: ${CONFIG.recoveryMode ? '✅ ENABLED' : '❌ DISABLED'}`);
        console.log(`  Shadow Pipeline: every ${CONFIG.shadowProposalIntervalMs / 1000}s`);
        console.log(`${bar}\n`);

        this._saveInterval = StatePersistence.autoSave(this);

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
            `🤖 <b>Accumulator Bot v4.1 Started 3b</b>\n\n` +
            `Assets: ${CONFIG.assets.join(', ')}\n` +
            `Stake: $${CONFIG.initialStake.toFixed(2)} | Growth: ${(CONFIG.growthRateDefault * 100).toFixed(0)}%–${(CONFIG.growthRateBoost * 100).toFixed(0)}%\n` +
            `Entry window: ticks ${CONFIG.minEntryTick}–${CONFIG.maxEntryTick}\n` +
            `Strategy: BB Squeeze + RSI Filter\n` +
            `⚡ Instant recovery pipeline: ACTIVE`
        );
    }

    shutdown(reason = 'manual') {
        console.log(`\n🛑 Shutting down — ${reason}`);
        this.shutdownFlag = true;
        this._stopShadowProposalTimer();
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
