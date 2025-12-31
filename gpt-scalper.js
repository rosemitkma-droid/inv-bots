'use strict';

/**
 * Deriv Multiplier Scalping + Safer Grid (single-file Node.js)
 *
 * Features:
 * - Multiplier contract autodiscovery via contracts_for (best-effort)
 * - Limit order feature-detection (TP/SL server-side if supported; else manual sell)
 * - Reconcile/attach to existing open contracts on startup (portfolio)
 * - Risk rails: daily loss limit, max consecutive losses, max open positions, cooldown, max position age
 * - Grid: optional, NON-martingale (stake decreases per layer via GRID_STAKE_FACTOR)
 * - Logging + JSONL trade journal
 *
 * Install:
 *   npm i ws pino dotenv
 * Run:
 *   node deriv_multiplier_bot.js
 *
 * Official docs (verify your schema/availability):
 *   https://deriv.com/docs/
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

let pino;
try { pino = require('pino'); } catch { pino = null; }

const log = pino
    ? pino({ level: process.env.LOG_LEVEL || 'info' })
    : console;

// -------------------- Config --------------------
function toNum(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}
function toInt(v, def) {
    const n = Number(v);
    return Number.isInteger(n) ? n : def;
}
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : x; }
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function pctMove(from, to) { return (!Number.isFinite(from) || from === 0) ? 0 : ((to - from) / from) * 100; }
function safeErr(e) { return { name: e?.name, message: e?.message, stack: e?.stack }; }

const CFG = {
    appId: String(process.env.DERIV_APP_ID || '1089'),
    token: String(process.env.DERIV_TOKEN || ''),
    wsUrl: (process.env.DERIV_WS_URL || '').trim() || null,

    symbol: String(process.env.SYMBOL || 'R_100'),
    currency: String(process.env.CURRENCY || 'USD'),

    // Default guesses for Multiplier contract types (autodiscovery will override if needed)
    contractTypeUp: String(process.env.CONTRACT_TYPE_UP || 'MULTUP'),
    contractTypeDown: String(process.env.CONTRACT_TYPE_DOWN || 'MULTDOWN'),

    stake: toNum(process.env.STAKE, 1),
    basis: String(process.env.BASIS || 'stake'),

    multiplier: toInt(process.env.MULTIPLIER, 40),

    // Risk/Reward thresholds as fraction of stake (profit/loss in currency)
    tpPct: toNum(process.env.TP_PCT, 0.25),
    slPct: toNum(process.env.SL_PCT, 0.15),

    // Indicators
    emaFast: Math.max(2, toInt(process.env.EMA_FAST, 20)),
    emaSlow: Math.max(3, toInt(process.env.EMA_SLOW, 60)),
    rsiLen: Math.max(2, toInt(process.env.RSI_LEN, 14)),

    // Execution pacing
    minTradeIntervalMs: Math.max(0, toInt(process.env.MIN_TRADE_INTERVAL_MS, 8000)),
    cooldownMs: Math.max(0, toInt(process.env.COOLDOWN_MS, 15000)),
    warmupTicks: Math.max(100, toInt(process.env.WARMUP_TICKS, 300)),

    // Exposure limits
    maxOpenPositions: Math.max(1, toInt(process.env.MAX_OPEN_POSITIONS, 1)),
    maxPositionMs: Math.max(30_000, toInt(process.env.MAX_POSITION_MS, 240_000)), // 4 min default
    dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',

    // Grid (safer: decreasing stake per layer, not increasing)
    gridEnabled: String(process.env.GRID_ENABLED || 'false').toLowerCase() === 'true',
    gridStepPct: Math.max(0.01, toNum(process.env.GRID_STEP_PCT, 0.20)),      // percent move against last add
    gridMaxLayers: Math.max(0, toInt(process.env.GRID_MAX_LAYERS, 0)),        // additional layers beyond first
    gridStakeFactor: clamp(toNum(process.env.GRID_STAKE_FACTOR, 0.7), 0.1, 1), // 0.7 => each layer 70% of previous

    // Session risk limits
    dailyLossLimit: Math.max(0, toNum(process.env.DAILY_LOSS_LIMIT, 10)),
    maxConsecLosses: Math.max(1, toInt(process.env.MAX_CONSEC_LOSSES, 4)),

    // Journal
    journalFile: String(process.env.JOURNAL_FILE || path.join(process.cwd(), 'trades.journal.jsonl')),
};

if (!CFG.token) {
    log.error('DERIV_TOKEN is missing. Set it in .env');
    process.exit(1);
}

if (CFG.emaFast >= CFG.emaSlow) {
    log.warn({ emaFast: CFG.emaFast, emaSlow: CFG.emaSlow }, 'EMA_FAST should be < EMA_SLOW for a sane trend filter');
}
if (CFG.tpPct <= 0 || CFG.slPct <= 0) {
    log.warn({ tpPct: CFG.tpPct, slPct: CFG.slPct }, 'TP_PCT/SL_PCT should be > 0');
}
if (CFG.tpPct <= CFG.slPct) {
    log.warn({ tpPct: CFG.tpPct, slPct: CFG.slPct }, 'TP_PCT <= SL_PCT (risk-reward not favorable). Consider TP > SL.');
}

const DERIV_WS =
    CFG.wsUrl ||
    `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(CFG.appId)}`;

// -------------------- Indicators --------------------
class EMA {
    constructor(period) {
        this.period = period;
        this.mult = 2 / (period + 1);
        this.value = null;
    }
    update(price) {
        if (!Number.isFinite(price)) return this.value;
        if (this.value === null) this.value = price;
        else this.value = (price - this.value) * this.mult + this.value;
        return this.value;
    }
}

class RSI {
    constructor(period) {
        this.period = period;
        this.prev = null;
        this.avgGain = null;
        this.avgLoss = null;
        this.value = null;
        this.seedCount = 0;
    }
    update(price) {
        if (!Number.isFinite(price)) return this.value;
        if (this.prev === null) { this.prev = price; return this.value; }

        const ch = price - this.prev;
        const gain = Math.max(0, ch);
        const loss = Math.max(0, -ch);
        this.prev = price;

        if (this.avgGain === null) {
            this.avgGain = 0;
            this.avgLoss = 0;
        }

        // Seed initial average
        if (this.seedCount < this.period) {
            this.avgGain += gain;
            this.avgLoss += loss;
            this.seedCount += 1;
            if (this.seedCount === this.period) {
                this.avgGain /= this.period;
                this.avgLoss /= this.period;
                this.value = this._calc();
            }
            return this.value;
        }

        // Wilder smoothing
        this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
        this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
        this.value = this._calc();
        return this.value;
    }
    _calc() {
        if (this.avgLoss === 0) return 100;
        const rs = this.avgGain / this.avgLoss;
        return 100 - 100 / (1 + rs);
    }
}

// -------------------- Deriv WS client --------------------
class DerivClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.reqId = 1;
        this.pending = new Map();     // req_id -> {resolve,reject}
        this.subHandlers = new Map(); // sid -> handler
        this.open = false;
        this.lastMessageAt = 0;
        this.heartbeatTimer = null;
    }

    connectOnce() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;

            ws.on('open', () => {
                this.open = true;
                this.lastMessageAt = now();
                log.info({ url: this.url }, 'WS connected');

                if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = setInterval(() => {
                    const idleMs = now() - this.lastMessageAt;
                    if (idleMs > 30_000) log.warn({ idleMs }, 'No WS messages recently (possible stall)');
                }, 10_000);

                resolve();
            });

            ws.on('message', (data) => {
                this.lastMessageAt = now();
                let msg;
                try { msg = JSON.parse(String(data)); }
                catch { log.warn({ data: String(data).slice(0, 200) }, 'Non-JSON message'); return; }

                if (msg.error) {
                    const rid = msg.req_id;
                    if (rid && this.pending.has(rid)) {
                        const p = this.pending.get(rid);
                        this.pending.delete(rid);
                        p.reject(new Error(`${msg.error.code || 'DerivError'}: ${msg.error.message}`));
                        return;
                    }
                    log.error({ msg }, 'Deriv API error (unsolicited)');
                    return;
                }

                if (msg.req_id && this.pending.has(msg.req_id)) {
                    const p = this.pending.get(msg.req_id);
                    this.pending.delete(msg.req_id);
                    p.resolve(msg);
                }

                if (msg.subscription?.id) {
                    const sid = msg.subscription.id;
                    const h = this.subHandlers.get(sid);
                    if (h) h(msg);
                }
            });

            ws.on('close', (code, reason) => {
                this.open = false;
                log.warn({ code, reason: String(reason || '') }, 'WS closed');
                for (const [, p] of this.pending.entries()) p.reject(new Error('WS closed'));
                this.pending.clear();
            });

            ws.on('error', (err) => {
                log.error({ err: safeErr(err) }, 'WS error');
                if (!this.open) reject(err);
            });
        });
    }

    send(req) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('WS not open'));
        }
        const req_id = this.reqId++;
        const payload = { ...req, req_id };
        return new Promise((resolve, reject) => {
            this.pending.set(req_id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }

    async subscribe(req, handler) {
        const res = await this.send({ ...req, subscribe: 1 });
        const sid = res?.subscription?.id;
        if (!sid) throw new Error('Subscribe did not return subscription id');
        this.subHandlers.set(sid, handler);
        return { sid, first: res };
    }

    async forget(sid) {
        try { await this.send({ forget: sid }); }
        catch (e) { log.warn({ err: safeErr(e), sid }, 'Forget failed'); }
        finally { this.subHandlers.delete(sid); }
    }
}

// -------------------- Journal --------------------
function journalWrite(obj) {
    try {
        fs.appendFileSync(CFG.journalFile, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
    } catch (e) {
        log.warn({ err: safeErr(e), file: CFG.journalFile }, 'Failed to write journal');
    }
}

// -------------------- Bot --------------------
class MultiplierBot {
    constructor(client) {
        this.c = client;

        this.emaF = new EMA(CFG.emaFast);
        this.emaS = new EMA(CFG.emaSlow);
        this.rsi = new RSI(CFG.rsiLen);

        this.tickSubId = null;

        this.price = null;
        this.tickCount = 0;
        this.warmed = false;

        this.realizedPnl = 0;
        this.consecLosses = 0;
        this.wins = 0;
        this.losses = 0;
        this.tradingEnabled = true;

        this.lastTradeAt = 0;
        this.cooldownUntil = 0;

        // Active positions by contract_id
        this.positions = new Map(); // contractId -> position

        // Campaign concept: lets grid adds only in same direction
        this.currentCampaign = null; // { direction, layers, lastAddPrice }

        // Autodetected settings
        this.ctUp = CFG.contractTypeUp;
        this.ctDown = CFG.contractTypeDown;
        this.multiplier = CFG.multiplier;
        this.supportsLimitOrder = true;
    }

    async start() {
        await this._authorize();
        await this._logBalance();
        await this._autodiscoverMultiplierContracts();
        await this._featureDetectLimitOrder();
        await this._attachToExistingOpenContracts();
        await this._warmupTicks();
        await this._subscribeTicks();

        log.info(
            {
                symbol: CFG.symbol,
                currency: CFG.currency,
                stake: CFG.stake,
                multiplier: this.multiplier,
                contractTypeUp: this.ctUp,
                contractTypeDown: this.ctDown,
                supportsLimitOrder: this.supportsLimitOrder,
                gridEnabled: CFG.gridEnabled,
                gridMaxLayers: CFG.gridMaxLayers,
                gridStakeFactor: CFG.gridStakeFactor,
                dryRun: CFG.dryRun,
            },
            'Bot started'
        );
    }

    async _authorize() {
        const res = await this.c.send({ authorize: CFG.token });
        const a = res?.authorize;
        log.info({ loginid: a?.loginid, currency: a?.currency, country: a?.country }, 'Authorized');
    }

    async _logBalance() {
        try {
            const res = await this.c.send({ balance: 1, subscribe: 0 });
            log.info({ balance: res?.balance?.balance, currency: res?.balance?.currency }, 'Balance snapshot');
        } catch (e) {
            log.warn({ err: safeErr(e) }, 'Balance request failed');
        }
    }

    async _autodiscoverMultiplierContracts() {
        // Best-effort: query contracts_for and try to locate likely multiplier "up/down" types and multiplier bounds.
        // If parsing fails, we fall back to CFG values.
        try {
            const res = await this.c.send({ contracts_for: CFG.symbol, currency: CFG.currency, landing_company: 'svg' });
            const avail = res?.contracts_for?.available || res?.contracts_for?.contracts || [];
            if (!Array.isArray(avail) || avail.length === 0) {
                log.warn('contracts_for returned no available contracts; using configured contract types');
                return;
            }

            // Pick candidates whose contract_type looks like multiplier up/down.
            const types = avail
                .map(x => x?.contract_type)
                .filter(t => typeof t === 'string');

            // Heuristic ranking
            const upCandidates = rankTypes(types, ['MULTUP', 'UP']);
            const downCandidates = rankTypes(types, ['MULTDOWN', 'DOWN']);

            const chosenUp = upCandidates[0] || this.ctUp;
            const chosenDown = downCandidates[0] || this.ctDown;

            this.ctUp = chosenUp;
            this.ctDown = chosenDown;

            // Try to find multiplier limits from matching entries
            const upObj = avail.find(x => x?.contract_type === chosenUp) || null;
            const downObj = avail.find(x => x?.contract_type === chosenDown) || null;

            const mult = chooseMultiplierFromContractInfo(this.multiplier, upObj || downObj);
            if (mult !== this.multiplier) {
                log.warn({ requested: this.multiplier, adjusted: mult }, 'Adjusted multiplier to fit available bounds (best-effort)');
                this.multiplier = mult;
            }

            log.info(
                { detectedUp: this.ctUp, detectedDown: this.ctDown, multiplier: this.multiplier, typesCount: types.length },
                'Autodiscovery complete'
            );
        } catch (e) {
            log.warn({ err: safeErr(e) }, 'Autodiscovery failed; using configured contract types/multiplier');
        }
    }

    async _featureDetectLimitOrder() {
        // We attempt a proposal with limit_order; if it errors, we disable limit_order usage.
        // This avoids repeated failures on brokers/symbols where limit_order isn't accepted for multipliers.
        const tpAmt = Math.max(0, CFG.stake * Math.max(0, CFG.tpPct));
        const slAmt = Math.max(0, CFG.stake * Math.max(0, CFG.slPct));

        const testReq = this._buildProposalReq({
            direction: 'UP',
            stake: CFG.stake,
            tpAmt,
            slAmt,
            includeLimitOrder: true,
        });

        try {
            await this.c.send(testReq);
            this.supportsLimitOrder = true;
            log.info('limit_order appears supported (proposal accepted)');
        } catch (e) {
            this.supportsLimitOrder = false;
            log.warn({ err: safeErr(e) }, 'limit_order not supported (or rejected); will use manual TP/SL sells');
        }
    }

    async _attachToExistingOpenContracts() {
        // If the bot restarts, it should re-attach and manage existing positions.
        try {
            const res = await this.c.send({ portfolio: 1 });
            const contracts = res?.portfolio?.contracts || [];
            if (!Array.isArray(contracts) || contracts.length === 0) {
                log.info('No open contracts in portfolio');
                return;
            }

            log.warn({ openContracts: contracts.length }, 'Found open contracts in portfolio; attaching');

            for (const k of contracts) {
                const contractId = k?.contract_id;
                if (!contractId) continue;

                // Register minimal position record so TP/SL and max age rules apply
                const pos = {
                    contractId,
                    direction: null,
                    contract_type: k?.contract_type || null,
                    stake: Number(k?.buy_price) || CFG.stake,
                    multiplier: this.multiplier,
                    openedAt: now(), // unknown; treat as now for max-age safety
                    tpAmt: Math.max(0, (Number(k?.buy_price) || CFG.stake) * CFG.tpPct),
                    slAmt: Math.max(0, (Number(k?.buy_price) || CFG.stake) * CFG.slPct),
                    openContractSubId: null,
                    isSold: false,
                    trailingStop: null,
                };

                this.positions.set(contractId, pos);

                const sub = await this.c.subscribe(
                    { proposal_open_contract: 1, contract_id: contractId },
                    (msg) => this._onOpenContract(msg).catch(err => log.error({ err: safeErr(err) }, 'open_contract handler error'))
                );
                pos.openContractSubId = sub.sid;

                // Process first snapshot
                await this._onOpenContract(sub.first);
            }
        } catch (e) {
            log.warn({ err: safeErr(e) }, 'portfolio attach failed (continuing anyway)');
        }
    }

    async _warmupTicks() {
        const res = await this.c.send({
            ticks_history: CFG.symbol,
            end: 'latest',
            style: 'ticks',
            count: CFG.warmupTicks,
        });
        const prices = res?.history?.prices || [];
        for (const p of prices) this._onPrice(Number(p), true);
        this.warmed = true;
        log.info({ warmupTicks: prices.length }, 'Indicators warmed');
    }

    async _subscribeTicks() {
        const sub = await this.c.subscribe({ ticks: CFG.symbol }, (msg) => {
            const q = Number(msg?.tick?.quote);
            if (Number.isFinite(q)) this._onPrice(q, false);
        });
        this.tickSubId = sub.sid;

        const firstQ = Number(sub?.first?.tick?.quote);
        if (Number.isFinite(firstQ)) this._onPrice(firstQ, false);

        log.info({ tickSubId: this.tickSubId }, 'Subscribed to ticks');
    }

    _signal(emaF, emaS, rsi) {
        if (!Number.isFinite(emaF) || !Number.isFinite(emaS) || !Number.isFinite(rsi)) return null;

        // Conservative scalping trigger:
        // - follow direction of EMA cross
        // - avoid taking longs when RSI is already high, or shorts when RSI is already low
        if (emaF > emaS && rsi < 68) return 'UP';
        if (emaF < emaS && rsi > 32) return 'DOWN';
        return null;
    }

    _riskCheck() {
        if (!this.tradingEnabled) return false;

        if (this.realizedPnl <= -Math.abs(CFG.dailyLossLimit)) {
            this.tradingEnabled = false;
            log.error({ realizedPnl: this.realizedPnl, limit: CFG.dailyLossLimit }, 'Daily loss limit hit; trading disabled');
            return false;
        }
        if (this.consecLosses >= CFG.maxConsecLosses) {
            this.tradingEnabled = false;
            log.error({ consecLosses: this.consecLosses, limit: CFG.maxConsecLosses }, 'Max consecutive losses hit; trading disabled');
            return false;
        }
        if (now() < this.cooldownUntil) return false;
        return true;
    }

    _onPrice(price, isWarmup) {
        this.price = price;
        this.tickCount += 1;

        const emaF = this.emaF.update(price);
        const emaS = this.emaS.update(price);
        const rsi = this.rsi.update(price);

        if (!isWarmup && this.tickCount % 25 === 0) {
            const activeDetails = Array.from(this.positions.values()).map(p => ({
                id: p.contractId,
                dir: p.direction,
                stake: p.stake,
                profit: round2(p.currentProfit || 0),
                age: Math.round((now() - p.openedAt) / 1000) + 's'
            }));

            log.info({
                price,
                emaF: round2(emaF),
                emaS: round2(emaS),
                rsi: round2(rsi),
                active: activeDetails,
                realizedPnl: round2(this.realizedPnl),
                wins: this.wins,
                losses: this.losses,
                consecLoss: this.consecLosses,
                tradingEnabled: this.tradingEnabled,
                campaign: this.currentCampaign ? { ...this.currentCampaign } : null,
            }, 'Market Snapshot');
        }

        if (isWarmup || !this.warmed) return;

        // Always manage existing positions (max-age safety)
        this._maybeCloseOldPositions().catch(e => log.error({ err: safeErr(e) }, 'maybeCloseOldPositions error'));

        // Risk rails before opening anything new
        if (!this._riskCheck()) return;

        // Optional grid adds
        this._maybeGridAdd().catch(e => log.error({ err: safeErr(e) }, 'maybeGridAdd error'));

        // New entries
        if (this.positions.size >= CFG.maxOpenPositions) return;
        if (now() - this.lastTradeAt < CFG.minTradeIntervalMs) return;

        const sig = this._signal(emaF, emaS, rsi);
        if (!sig) return;

        // Start/maintain campaign direction
        if (!this.currentCampaign) {
            this.currentCampaign = { direction: sig, layers: 0, lastAddPrice: price };
        }
        if (this.currentCampaign.direction !== sig) return;

        // Open initial layer
        if (this.currentCampaign.layers === 0) {
            this._openPosition({ direction: sig, refPrice: price, layerIndex: 0 }).catch(e => {
                log.error({ err: safeErr(e) }, 'Open position failed');
            });
        }
    }

    async _maybeGridAdd() {
        if (!CFG.gridEnabled) return;
        if (!this.currentCampaign) return;
        if (this.currentCampaign.layers <= 0) return; // no initial layer yet
        if (this.currentCampaign.layers >= (1 + CFG.gridMaxLayers)) return;
        if (this.positions.size >= CFG.maxOpenPositions) return;
        if (now() - this.lastTradeAt < CFG.minTradeIntervalMs) return;

        const price = this.price;
        if (!Number.isFinite(price)) return;

        const dir = this.currentCampaign.direction;
        const lastAdd = this.currentCampaign.lastAddPrice;

        const movePct = pctMove(lastAdd, price);

        const against =
            (dir === 'UP' && movePct <= -Math.abs(CFG.gridStepPct)) ||
            (dir === 'DOWN' && movePct >= Math.abs(CFG.gridStepPct));

        if (!against) return;

        const nextLayerIndex = this.currentCampaign.layers; // 1st add after initial => layerIndex 1, etc.
        log.warn({ dir, lastAddPrice: lastAdd, price, movePct: round2(movePct), nextLayerIndex }, 'Grid add triggered');

        await this._openPosition({ direction: dir, refPrice: price, layerIndex: nextLayerIndex });
    }

    async _maybeCloseOldPositions() {
        // Hard “stale position” safety: if contract stays open too long, close it.
        const t = now();
        for (const [cid, pos] of this.positions.entries()) {
            if (pos.isSold) continue;
            const age = t - pos.openedAt;
            if (age > CFG.maxPositionMs) {
                log.warn({ contractId: cid, ageMs: age, maxPositionMs: CFG.maxPositionMs }, 'Max position age exceeded; selling');
                await this._safeSell(cid);
            }
        }
    }

    _buildProposalReq({ direction, stake, tpAmt, slAmt, includeLimitOrder }) {
        const contract_type = direction === 'UP' ? this.ctUp : this.ctDown;

        const req = {
            proposal: 1,
            amount: stake,
            basis: CFG.basis,
            contract_type,
            currency: CFG.currency,
            symbol: CFG.symbol,

            // Verify multiplier schema in Deriv docs for your environment.
            multiplier: this.multiplier,
        };

        if (includeLimitOrder && (tpAmt > 0 || slAmt > 0)) {
            req.limit_order = {};
            if (tpAmt > 0) req.limit_order.take_profit = tpAmt;
            if (slAmt > 0) req.limit_order.stop_loss = slAmt;
        }
        return req;
    }

    _layerStake(layerIndex) {
        // Non-martingale: stake decreases with layers.
        // layerIndex 0 => CFG.stake
        // layerIndex 1 => CFG.stake * factor
        // ...
        const s = CFG.stake * Math.pow(CFG.gridStakeFactor, layerIndex);
        // Avoid going to zero; keep minimum sensible stake (still may be rejected by broker min stake rules).
        return Math.max(0.35, round2(s));
    }

    async _openPosition({ direction, refPrice, layerIndex }) {
        if (!this._riskCheck()) return;
        if (!Number.isFinite(refPrice)) throw new Error('Invalid refPrice');

        const stake = this._layerStake(layerIndex);
        const tpAmt = Math.max(0, stake * Math.max(0, CFG.tpPct));
        const slAmt = Math.max(0, stake * Math.max(0, CFG.slPct));
        const contract_type = direction === 'UP' ? this.ctUp : this.ctDown;

        this.lastTradeAt = now();

        const proposalReq = this._buildProposalReq({
            direction,
            stake,
            tpAmt,
            slAmt,
            includeLimitOrder: this.supportsLimitOrder,
        });

        log.info({ direction, contract_type, stake, multiplier: this.multiplier, tpAmt, slAmt, dryRun: CFG.dryRun }, 'Requesting proposal');

        let proposalRes;
        try {
            proposalRes = await this.c.send(proposalReq);
        } catch (e) {
            // Fallback: if limit_order is the issue, disable and retry once.
            if (this.supportsLimitOrder) {
                log.warn({ err: safeErr(e) }, 'Proposal failed; retrying once without limit_order');
                this.supportsLimitOrder = false;
                const retryReq = this._buildProposalReq({ direction, stake, tpAmt, slAmt, includeLimitOrder: false });
                proposalRes = await this.c.send(retryReq);
            } else {
                throw e;
            }
        }

        const proposalId = proposalRes?.proposal?.id;
        if (!proposalId) throw new Error('No proposal id returned');

        if (CFG.dryRun) {
            log.warn({ direction, contract_type, stake, proposalId }, 'DRY_RUN enabled: skipping buy()');
            // Update campaign state as if opened? No—keep conservative: do not advance layers in dry run.
            return;
        }

        const buyRes = await this.c.send({ buy: proposalId, price: stake });
        const buy = buyRes?.buy;
        const contractId = buy?.contract_id;
        if (!contractId) throw new Error('No contract_id returned from buy');

        const pos = {
            contractId,
            direction,
            contract_type,
            stake,
            multiplier: this.multiplier,
            refEntryPrice: refPrice,
            openedAt: now(),
            tpAmt,
            slAmt,
            openContractSubId: null,
            isSold: false,
            trailingStop: null, // optional enhancement: set once profit grows
        };

        this.positions.set(contractId, pos);

        if (!this.currentCampaign) this.currentCampaign = { direction, layers: 0, lastAddPrice: refPrice };
        this.currentCampaign.layers += 1;
        this.currentCampaign.lastAddPrice = refPrice;

        log.info({ contractId, direction, refEntryPrice: refPrice, layers: this.currentCampaign.layers, stake }, 'Position opened');
        journalWrite({ event: 'OPEN', contractId, direction, contract_type, stake, multiplier: this.multiplier, refEntryPrice: refPrice });

        const sub = await this.c.subscribe(
            { proposal_open_contract: 1, contract_id: contractId },
            (msg) => this._onOpenContract(msg).catch(err => log.error({ err: safeErr(err) }, 'open_contract handler error'))
        );
        pos.openContractSubId = sub.sid;

        await this._onOpenContract(sub.first);
    }

    async _onOpenContract(msg) {
        const c = msg?.proposal_open_contract;
        if (!c) return;

        const contractId = c.contract_id;
        const pos = this.positions.get(contractId);
        if (!pos) return;

        const profit = Number(c.profit);
        const isSold = Boolean(c.is_sold);

        // Update current profit for real-time monitoring
        pos.currentProfit = profit;

        // Manual TP/SL sells if still open
        if (!isSold && !pos.isSold && Number.isFinite(profit)) {
            // Optional trailing stop logic (simple):
            // once profit exceeds 60% of TP target, set trailingStop to protect ~40% of TP target.
            if (pos.tpAmt > 0 && profit >= pos.tpAmt * 0.6 && pos.trailingStop === null) {
                pos.trailingStop = profit - pos.tpAmt * 0.4;
                log.info({ contractId, profit: round2(profit), trailingStop: round2(pos.trailingStop) }, 'Trailing stop armed');
            }
            if (pos.trailingStop !== null && profit <= pos.trailingStop) {
                log.warn({ contractId, profit: round2(profit), trailingStop: round2(pos.trailingStop) }, 'Trailing stop hit; selling');
                await this._safeSell(contractId);
                return;
            }

            if (pos.tpAmt > 0 && profit >= pos.tpAmt) {
                log.info({ contractId, profit: round2(profit), tpAmt: round2(pos.tpAmt) }, 'TP reached; selling');
                await this._safeSell(contractId);
                return;
            }
            if (pos.slAmt > 0 && profit <= -pos.slAmt) {
                log.warn({ contractId, profit: round2(profit), slAmt: round2(pos.slAmt) }, 'SL reached; selling');
                await this._safeSell(contractId);
                return;
            }
        }

        // Settlement
        if (isSold && !pos.isSold) {
            pos.isSold = true;

            const realized = Number.isFinite(profit) ? profit : 0;
            this.realizedPnl += realized;

            const result = realized < 0 ? 'LOSS' : 'WIN';
            if (result === 'LOSS') {
                this.consecLosses += 1;
                this.losses += 1;
            } else {
                this.consecLosses = 0;
                this.wins += 1;
            }

            log.info(
                {
                    contractId,
                    dir: pos.direction,
                    result,
                    realized: round2(realized),
                    realizedPnlTotal: round2(this.realizedPnl),
                    wins: this.wins,
                    losses: this.losses,
                    consecLoss: this.consecLosses,
                },
                'Position Closed'
            );

            journalWrite({ event: 'CLOSE', contractId, realized: round2(realized), realizedPnlTotal: round2(this.realizedPnl) });

            if (pos.openContractSubId) await this.c.forget(pos.openContractSubId);
            this.positions.delete(contractId);

            if (this.positions.size === 0) {
                this.currentCampaign = null;
                this.cooldownUntil = now() + CFG.cooldownMs;
            }
        }
    }

    async _safeSell(contractId) {
        try {
            await this.c.send({ sell: contractId, price: 0 });
        } catch (e) {
            log.error({ err: safeErr(e), contractId }, 'Sell failed');
        }
    }
}

// -------------------- Autodiscovery helpers --------------------
function rankTypes(types, needles) {
    // Return list of types ranked by how well they match needles.
    // needles earlier => higher priority.
    const scored = [];
    for (const t of types) {
        let score = 0;
        const u = t.toUpperCase();
        for (let i = 0; i < needles.length; i++) {
            const n = String(needles[i]).toUpperCase();
            if (u === n) score += 1000 - i;
            else if (u.includes(n)) score += 100 - i;
        }
        if (score > 0) scored.push({ t, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.t);
}

function chooseMultiplierFromContractInfo(requested, contractInfo) {
    // Best-effort: look for multiplier bounds/list in contract info.
    // If not found, return requested.
    if (!contractInfo || typeof contractInfo !== 'object') return requested;

    // Common patterns we try to interpret without assuming exact schema:
    // - contractInfo.multiplier_range: {min,max}
    // - contractInfo.multiplier: [ ... ]
    // - contractInfo.multiplier_values: [ ... ]
    const r = contractInfo.multiplier_range;
    if (r && Number.isFinite(Number(r.min)) && Number.isFinite(Number(r.max))) {
        return Math.round(clamp(requested, Number(r.min), Number(r.max)));
    }
    const arr = contractInfo.multiplier || contractInfo.multiplier_values;
    if (Array.isArray(arr) && arr.length > 0) {
        const nums = arr.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (nums.length === 0) return requested;
        // nearest
        let best = nums[0], bestD = Math.abs(nums[0] - requested);
        for (const m of nums) {
            const d = Math.abs(m - requested);
            if (d < bestD) { best = m; bestD = d; }
        }
        return Math.round(best);
    }
    return requested;
}

// -------------------- Main loop with reconnect --------------------
(async function main() {
    log.info(
        {
            appId: CFG.appId,
            symbol: CFG.symbol,
            currency: CFG.currency,
            stake: CFG.stake,
            multiplier: CFG.multiplier,
            emaFast: CFG.emaFast,
            emaSlow: CFG.emaSlow,
            rsiLen: CFG.rsiLen,
            gridEnabled: CFG.gridEnabled,
            gridMaxLayers: CFG.gridMaxLayers,
            gridStakeFactor: CFG.gridStakeFactor,
            maxOpenPositions: CFG.maxOpenPositions,
            dailyLossLimit: CFG.dailyLossLimit,
            maxConsecLosses: CFG.maxConsecLosses,
            dryRun: CFG.dryRun,
            journalFile: CFG.journalFile,
        },
        'Starting...'
    );

    process.on('SIGINT', () => {
        log.warn('SIGINT received; exiting');
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        log.warn('SIGTERM received; exiting');
        process.exit(0);
    });

    let backoff = 500;
    const backoffMax = 10_000;

    while (true) {
        const client = new DerivClient(DERIV_WS);
        try {
            await client.connectOnce();
            const bot = new MultiplierBot(client);
            await bot.start();

            backoff = 500;

            // Stay alive while WS open
            while (client.ws && client.ws.readyState === WebSocket.OPEN) {
                await sleep(1000);
            }

            log.warn('WS disconnected; reconnecting');
        } catch (e) {
            log.error({ err: safeErr(e) }, 'Run failed; reconnecting');
            await sleep(backoff);
            backoff = Math.min(backoffMax, Math.floor(backoff * 1.7));
        }
    }
})().catch((e) => {
    log.error({ err: safeErr(e) }, 'Uncaught main error');
    process.exit(1);
});
