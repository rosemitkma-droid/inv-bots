require('dotenv').config();
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const EventEmitter = require('events');
const crypto = require('crypto');

// ── env + logging helpers ───────────────────────────────────────────────
function numEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; const x = Number(v); return Number.isFinite(x) ? x : d; }
function intEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; }
function strEnv(n, d) { const v = process.env[n]; return v == null || v === '' ? d : String(v).trim(); }
function boolEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase()); }
const logger = {
    error: (...a) => console.error(...a),
    warn: (...a) => console.warn(...a),
    info: (...a) => console.log(...a),
    debug: (...a) => console.log(...a),
};
const pad = n => String(n).padStart(2, '0');
function utcTs() { const d = new Date(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`; }
function htmlEscape(s) { return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])); }

// ── CONFIG — credentials from randomDigitDifferV2.js ───────────────────
const CONFIG = Object.freeze({
    apiToken:    'pat_e02a554e3b6f9f939c07855fe28c91c68e58ea14f741f45f675f82de96da4289',
    appId:       '33uslPtthXBEkQOdfKfoY',
    accountId:   '',
    accountType: 'demo',
    legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
    restBaseUrl: 'https://api.derivws.com',
    currency:    'USD',

    
    // ── multi-asset selection / suspension ─────────────────────────────
    randomAssetSelection:   boolEnv('RANDOM_ASSET_SELECTION', true), // pick a random asset each trade
    suspendAssetAfterTrade: boolEnv('SUSPEND_AFTER_TRADE', false),   // suspend traded asset after each trade
    singleActiveAsset:      boolEnv('ONE_ASSET_AT_A_TIME', true),     // subscribe + trade ONE random asset per cycle

    // ── SESSION takeProfit cooldown (random) ───────────────────────────
    takeProfitCooldownMinMs: intEnv('TAKE_PROFIT_COOLDOWN_MS_MIN', 15 * 60 * 1000), // 15 min
    takeProfitCooldownMaxMs: intEnv('TAKE_PROFIT_COOLDOWN_MS_MAX', 60 * 60 * 1000), // 60 min

    // ── persistence (survive restart / network drop) ───────────────────
    stateFile: strEnv('STATE_FILE', 'randomDiffer_state_01.json'),

    telegram: {
        enabled:  true,
        botToken: '8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8',
        chatId:   '752497117',
    },
    reconnect: {
        initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
        maxDelayMs:     intEnv('RECONNECT_MAX_MS', 60000),
        backoffFactor:  numEnv('RECONNECT_BACKOFF', 2),
        jitterMs:       intEnv('RECONNECT_JITTER_MS', 750),
    },
});

// ── TELEGRAM notifier (flood-aware, same as randomDigitDifferV2.js) ─────
class TelegramNotifier extends EventEmitter {
    constructor(cfg) {
        super();
        this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
        this.botToken = cfg.botToken; this.chatId = cfg.chatId;
        this.q = []; this.sending = false;
        this.gapMs = Math.max(1000, numEnv('TELEGRAM_GAP_MS', 3000));
        this.maxQ = Math.max(10, intEnv('TELEGRAM_MAX_QUEUE', 100));
        this.bannedUntil = 0; this._lastBanLog = 0;
    }
    _parseRetryAfter(body) {
        try { const j = JSON.parse(String(body || '')); const s = j?.parameters?.retry_after; if (Number.isFinite(Number(s))) return Number(s); } catch (_) {}
        const m = String(body || '').match(/retry after (\d+)/i); return m ? Number(m[1]) : 0;
    }
    _post(text) {
        return new Promise(res => {
            if (!this.enabled) return res({ ok: false, retryAfter: 0 });
            try {
                const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
                const u = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
                const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 15000 }, r => {
                    let body = '';
                    r.on('data', c => { body += c; if (body.length > 500) body = body.slice(0, 500); });
                    r.on('end', () => {
                        const ok = r.statusCode === 200;
                        let retryAfter = 0;
                        if (!ok) {
                            retryAfter = (r.statusCode === 429) ? (this._parseRetryAfter(body) || 60) : 0;
                            logger.warn(`telegram send failed: http=${r.statusCode} retryAfter=${retryAfter}s body=${body.slice(0, 200)}`);
                        }
                        res({ ok, retryAfter });
                    });
                });
                req.on('error', e => { logger.warn('telegram:', e.message); res({ ok: false, retryAfter: 0 }); });
                req.on('timeout', () => { req.destroy(new Error('tg timeout')); res({ ok: false, retryAfter: 0 }); });
                req.write(payload); req.end();
            } catch (e) { logger.warn('telegram exc:', e.message); res({ ok: false, retryAfter: 0 }); }
        });
    }
    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async _drain() {
        if (this.sending || !this.q.length) return;
        this.sending = true;
        try {
            while (this.q.length) {
                const waitMs = this.bannedUntil - Date.now();
                if (waitMs > 0) {
                    if (Date.now() - this._lastBanLog > 60000) { this._lastBanLog = Date.now(); logger.warn(`telegram flood ban active — pausing sends for ${(waitMs / 1000).toFixed(0)}s (queue=${this.q.length})`); }
                    await this._sleep(Math.min(waitMs, 30000));
                    continue;
                }
                const msg = this.q.shift();
                const r = await this._post(msg.text);
                if (!r.ok && r.retryAfter > 0) {
                    this.bannedUntil = Date.now() + r.retryAfter * 1000;
                    this._lastBanLog = 0;
                    if (r.retryAfter > 300) {
                        const kept = this.q.filter(m => m.pr === 'high');
                        const dropped = this.q.length - kept.length;
                        this.q.length = 0; this.q.push(...kept);
                        if (msg.pr === 'high') this.q.unshift(msg);
                        logger.warn(`telegram flood ban ${r.retryAfter}s — dropped ${dropped} queued routine notification(s), kept ${kept.length} alert(s)`);
                    } else {
                        this.q.unshift(msg);
                        logger.warn(`telegram 429 — retry_after ${r.retryAfter}s, pausing (queue=${this.q.length})`);
                    }
                    continue;
                }
                await this._sleep(this.gapMs);
            }
        } finally { this.sending = false; }
    }
    send(t, pr = 'normal') {
        if (!this.enabled) { logger.warn('telegram send skipped: notifier disabled (check botToken/chatId)'); return; }
        if (pr !== 'low' && pr !== 'high') pr = 'normal';
        this.q.push({ text: String(t), pr });
        while (this.q.length > this.maxQ) {
            const li = this.q.findIndex(m => m.pr === 'low');
            if (li >= 0) { this.q.splice(li, 1); continue; }
            const ni = this.q.findIndex(m => m.pr === 'normal');
            this.q.splice(ni >= 0 ? ni : 0, 1);
        }
        if (this.q.length > 20 && this.q.length % 10 === 1) logger.warn(`telegram queue backlogged (depth=${this.q.length}) — notifications will lag`);
        this._drain().catch(e => logger.warn('tg drain:', e.message));
    }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ── REST + WS CLIENT (new PAT connection — same as randomDigitDifferV2.js)
class RestClient {
    constructor(base, appId, token) { this.baseUrl = base; this.appId = appId; this.token = token; }
    static isPat(t) { return typeof t === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(t.trim()); }
    request(method, route, body = null) {
        return new Promise((res, rej) => {
            let u; try { u = new URL(route, this.baseUrl); } catch (e) { return rej(new Error(`Bad URL ${route}`)); }
            const payload = body == null ? null : JSON.stringify(body);
            const req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { Authorization: `Bearer ${this.token}`, 'Deriv-App-ID': this.appId, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }, timeout: 15000 }, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => { try { d = JSON.parse(d); } catch (_) {} res({ status: r.statusCode, body: d }); });
            });
            req.on('timeout', () => req.destroy(new Error('REST timeout'))); req.on('error', rej);
            if (payload) req.write(payload); req.end();
        });
    }
    get(r) { return this.request('GET', r); }
    post(r, b) { return this.request('POST', r, b); }
}

class DerivClient extends EventEmitter {
    constructor(cfg) {
        super(); this.cfg = cfg; this.ws = null; this.connected = false; this.authorized = false;
        this._stopped = false; this._suspended = false; this._reconnecting = false; this._reconnectAttempt = 0; this._reqId = 0;
        this._pending = new Map(); this._subs = new Map(); this.balance = null; this.currency = cfg.currency;
        this.accountInfo = null; this.symbols = new Map();
        this._isPat = RestClient.isPat(cfg.apiToken);
        this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
        this._targetAccountId = cfg.accountId || '';
    }
    _nextId() { return ++this._reqId; }
    _legacyUrl() { const s = this.cfg.legacyWsUrl.includes('?') ? '&' : '?'; return `${this.cfg.legacyWsUrl}${s}app_id=${encodeURIComponent(this.cfg.appId)}`; }
    _redact(u) { return String(u).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***'); }
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        if (!this.cfg.apiToken) { logger.error('API token empty'); this._stopped = true; return; }
        if (this._isPat) this._connectPat().catch(e => { logger.error('PAT connect:', e.message); this._schedReconnect(); });
        else this._openWs(this._legacyUrl());
    }
    async _connectPat() {
        const aid = await this._resolvePatAccountId();
        const route = `/trading/v1/options/accounts/${encodeURIComponent(aid)}/otp`;
        const res = await this._rest.post(route);
        if (res.status !== 200) { const m = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body); throw new Error(`OTP ${res.status}: ${m}`); }
        const wsUrl = res.body?.data?.url; if (!wsUrl) throw new Error(`OTP missing url: ${JSON.stringify(res.body)}`);
        this._targetAccountId = aid;
        this.accountInfo = { loginid: aid, accountType: this.cfg.accountType, isVirtual: this.cfg.accountType !== 'real', currency: this.cfg.currency };
        logger.info(`connecting → ${this._redact(wsUrl)}`); this._openWs(wsUrl);
    }
    async _resolvePatAccountId() {
        if (this._targetAccountId) return this._targetAccountId;
        for (const [m, r] of [['GET', '/trading/v1/options/accounts'], ['POST', '/trading/v1/options/accounts/list']]) {
            try {
                const res = m === 'GET' ? await this._rest.get(r) : await this._rest.post(r, null);
                if (res.status >= 200 && res.status < 300) {
                    const arr = Array.isArray(res.body?.data) ? res.body.data : Array.isArray(res.body?.accounts) ? res.body.accounts : [];
                    if (arr.length) { const d = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0]; const id = d.account_id || d.loginid || d.id; if (id) { this.accountInfo = { loginid: id, accountType: d.account_type || this.cfg.accountType, isVirtual: String(d.account_type || this.cfg.accountType).toLowerCase() !== 'real', currency: d.currency || this.cfg.currency, balance: d.balance != null ? Number(d.balance) : null }; return id; } }
                }
            } catch (e) { logger.debug(`PAT discovery ${m} ${r}:`, e.message); }
        }
        throw new Error('DERIV_ACCOUNT_ID required for PAT');
    }
    _openWs(url) {
        try { this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DigitPredictorV2/2.0' } }); } catch (e) { logger.error('WS construct:', e.message); this._schedReconnect(); return; }
        this.ws.on('open', () => this._onOpen()); this.ws.on('message', d => this._onMsg(d)); this.ws.on('error', e => this._onErr(e)); this.ws.on('close', (c, r) => this._onClose(c, r));
        this.ws.on('unexpected-response', (_, res) => { logger.error('WS handshake:', res.statusCode, res.statusMessage); try { res.destroy(); } catch (_) {} this._schedReconnect(); });
    }
    _onOpen() { logger.info('WS connected ✔'); this.connected = true; this._reconnecting = false; this._reconnectAttempt = 0; this.emit('open'); if (this._isPat) this._markPatAuth(); else this._authLegacy(); }
    async _authLegacy() {
        try {
            const res = await this._send({ authorize: this.cfg.apiToken }, 20000); const a = res.authorize;
            this.authorized = true; this.balance = Number(a.balance); this.currency = a.currency || this.cfg.currency;
            this.accountInfo = { loginid: a.loginid, email: a.email, isVirtual: !!a.is_virtual, accountType: a.account_type, currency: this.currency };
            logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance} ${this.currency}`); this.emit('authorized', this.accountInfo);
        } catch (e) { logger.error('authorize:', e.message); this.authorized = false; this._schedReconnect(); }
    }
    async _markPatAuth() {
        this.authorized = true; if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance); this.currency = this.accountInfo?.currency || this.cfg.currency;
        try { const b = await this._send({ balance: 1 }, 10000); if (b.balance) { this.balance = Number(b.balance.balance); this.currency = b.balance.currency || this.currency; } } catch (e) { logger.debug('balance skip:', e.message); }
        logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT bal=${this.balance ?? '?'} ${this.currency}`); this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' });
    }
    _onMsg(data) {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.error) {
            const code = msg.error.code || 'Error', text = msg.error.message || code;
            const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
            (benign.has(code) ? logger.debug : logger.error)(`api: ${code} - ${text} req=${msg.req_id || '?'}`);
            if (msg.req_id && this._pending.has(msg.req_id)) { const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.reject(new Error(text)); }
            if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) try { this.ws?.close(); } catch (_) {}
            return;
        }
        if (msg.req_id && this._pending.has(msg.req_id)) { const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg); return; }
        if (msg.subscription?.id && this._subs.has(msg.subscription.id)) { const cb = this._subs.get(msg.subscription.id); try { cb(msg); } catch (e) { logger.error('sub handler:', e.message); } return; }
        this.emit('message', msg);
    }
    _onErr(e) { logger.error('WS error:', e.message, e.code || ''); this.emit('error', e); }
    _onClose(code, reason) {
        const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
        logger.warn(`WS closed code=${code} ${rs || ''}`); const was = this.authorized; this.connected = false; this.authorized = false;
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); } this._pending.clear(); this._subs.clear();
        this.emit('close', code, reason, was); if (!this._stopped && !this._suspended) this._schedReconnect();
    }
    _schedReconnect() {
        if (this._stopped || this._suspended || this._reconnecting) return; this._reconnecting = true; this._reconnectAttempt++;
        const base = Math.min(this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1), this.cfg.reconnect.maxDelayMs);
        const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
        logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
        setTimeout(() => { this._reconnecting = false; this.connect(); }, delay);
    }
    _send(payload, timeoutMs = 30000) {
        return new Promise((res, rej) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('Not connected'));
            const id = this._nextId();
            const timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); rej(new Error('Request timeout')); } }, timeoutMs);
            this._pending.set(id, { resolve: res, reject: rej, timer });
            try { this.ws.send(JSON.stringify({ ...payload, req_id: id })); } catch (e) { clearTimeout(timer); this._pending.delete(id); rej(e); }
        });
    }
    subscribe(payload, cb, timeoutMs = 30000) {
        return new Promise((res, rej) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('Not connected'));
            const id = this._nextId();
            const timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); rej(new Error('Subscribe timeout')); } }, timeoutMs);
            this._pending.set(id, { resolve: msg => { const sid = msg.subscription?.id; if (!sid) return rej(new Error('No sub id')); this._subs.set(sid, cb); res(sid); }, reject: rej, timer });
            try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: id })); } catch (e) { clearTimeout(timer); this._pending.delete(id); rej(e); }
        });
    }
    forget(subId) { if (!subId) return Promise.resolve(); this._subs.delete(subId); if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(); return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message)); }
    suspend() { this._suspended = true; try { this.ws?.close(); } catch (_) {} }
    resume() { this._suspended = false; this.connect(); }
    stop() { this._stopped = true; try { this.ws?.close(); } catch (_) {} }
    symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

class EnhancedDigitDifferTradingBot {
    constructor(config = {}) {
        this.currency = CONFIG.currency;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100'
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            // 'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit != null ? config.takeProfit : 25,
            takeProfitCooldownMinMs: config.takeProfitCooldownMinMs || CONFIG.takeProfitCooldownMinMs,
            takeProfitCooldownMaxMs: config.takeProfitCooldownMaxMs || CONFIG.takeProfitCooldownMaxMs,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            randomAssetSelection: config.randomAssetSelection != null ? config.randomAssetSelection : CONFIG.randomAssetSelection,
            suspendAssetAfterTrade: config.suspendAssetAfterTrade != null ? config.suspendAssetAfterTrade : CONFIG.suspendAssetAfterTrade,
            singleActiveAsset: config.singleActiveAsset != null ? config.singleActiveAsset : CONFIG.singleActiveAsset,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
        };

        this.stateFile = config.stateFile || CONFIG.stateFile;

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.currentAsset = null;
        this.activeAsset = null; // single-active-asset mode: the one asset subscribed + traded this cycle
        this.lastOpenDigits = [];
        this.lastOpenStake = 0;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();
        this.settledContracts = new Set();
        this.rStats = {};
        this.sys = 1;

        // ── session / takeProfit state (V2) ─────────────────────────────
        this._sessionNum = 1;
        this._sessionStartAt = Date.now();
        this._sessionStartBal = 0;
        this._sessionPL = 0;
        this._sessionTrades = 0;
        this._tpAwaiting = false;
        this._tpPauseUntil = 0;
        this._tpResumeT = null;
        this._stopped = false;
        this.startBalance = null;

        // ── in-flight contract reconciliation (survive restart/drop) ────
        this.pendingContractId = null;
        this.pendingContractAsset = null;
        this.pendingContractDigit = null;

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.lastDigits2[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });

        this.client = new DerivClient(CONFIG);
        this.client.on('open', () => {
            console.log('Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.reconnectAttempts = 0;
        });
        this.client.on('authorized', () => this.handleAuthorized());
        this.client.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.connected = false;
            this.wsReady = false;
        });
        this.client.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.todayPnL = 0;
        this.dailyStats = {};
        this.hourlyStats = {};
        this.eodTimeGmt = '00:00';
        this._hourlyBoot = null;
        this._hourlyT = null;
        this._eodBoot = null;

        this._loadState();

        this.startTelegramTimer();
    }

    connect() {
        if (!this.Pause) {
            console.log('Attempting to connect to Deriv API...');
            this.client.connect();
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorNotification('Invalid API token');
                this.stopTrading();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
        }
    }

    async handleAuthorized() {
        console.log('Authentication successful');

        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });
        this.tickSubscriptionIds = {};
        this.retryCount = 0;

        // Every reconnect is a NEW trade cycle. Single-active-asset mode picks
        // a fresh random asset for THIS trade and subscribes only to it; the
        // previous cycle's asset is discarded (subscriptions die with the old
        // socket — the bot disconnects after every trade).
        if (this.config.singleActiveAsset) {
            this.activeAsset = this._pickActiveAsset();
            console.log(`🎲 Next trade asset (random pick per trade): ${this.activeAsset}`);
        }

        await this.initializeSubscriptions();

        if (this.startBalance == null && this.client.balance != null) this.startBalance = this.client.balance;

        // If a session takeProfit pause survived the restart, honor it;
        // resume immediately only when the persisted cooldown already elapsed.
        if (this._tpAwaiting && Date.now() >= this._tpPauseUntil) {
            this._startNewSession('pause elapsed during restart');
        }

        // Reconcile any contract left open across a restart / network drop.
        await this._reconcilePendingContract();

        const sessionLine = this._tpAwaiting
            ? '⏸ ' + this._sessionLine() + ' — resumes ' + new Date(this._tpPauseUntil).toUTCString()
            : '▶ ' + this._sessionLine();

        const assetsLine = this.config.singleActiveAsset
            ? '🎲 This trade: <code>' + htmlEscape(this.activeAsset || '?') + '</code> (random pick per trade) | pool: <code>' + this.assets.join(', ') + '</code>'
            : '📊 Assets: <code>' + this.assets.join(', ') + '</code> (' + (this.config.randomAssetSelection ? 'random pick' : 'tick-driven') + ')';

        telegram.send(
            '🤖 <b>Random Digit Multi-Asset Bot — ONLINE</b>\n' +
            '👤 <code>' + htmlEscape(this.client.accountInfo?.loginid || '?') + '</code> ' + (this.client.accountInfo?.isVirtual ? '🟡 DEMO' : '🔴 REAL') + '\n' +
            '💰 ' + Number(this.client.balance ?? 0).toFixed(2) + ' ' + this.currency + '\n' +
            assetsLine + '\n' +
            '💵 Base stake: ' + this.config.initialStake.toFixed(2) + ' | next: ' + this.currentStake.toFixed(2) + '\n' +
            sessionLine + '\n' +
            '💼 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses + ') | P/L <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '🕒 ' + utcTs(),
            'high'
        );
    }

    getLastDigit(quote, asset) {
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

    async initializeSubscriptions() {
        // Single-active-asset mode: subscribe ONLY to the randomly selected
        // asset this cycle (one ticks_history + one ticks stream) to cut latency.
        const targets = this.config.singleActiveAsset
            ? (this.activeAsset ? [this.activeAsset] : [])
            : this.assets;
        console.log(`Initializing subscriptions for ${targets.length} asset(s): ${targets.join(', ')}...`);
        for (const asset of targets) {
            await this.subscribeToTickHistory(asset);
            await this.subscribeToTicks(asset);
        }
    }

    async subscribeToTickHistory(asset) {
        try {
            const res = await this.client._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            }, 30000);
            if (res && res.history) this.handleTickHistory(asset, res.history);
        } catch (e) {
            console.error(`Failed to fetch tick history for ${asset}:`, e.message);
        }
    }

    async subscribeToTicks(asset) {
        try {
            const subId = await this.client.subscribe({ ticks: asset }, (msg) => {
                if (msg.tick) this.handleTickUpdate(msg.tick);
            });
            this.tickSubscriptionIds[asset] = subId;
        } catch (e) {
            console.error(`Failed to subscribe to ticks for ${asset}:`, e.message);
        }
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;

        // Single-active-asset mode: only the selected asset is subscribed and
        // traded; ignore anything else that might arrive on the wire.
        if (this.config.singleActiveAsset && asset !== this.activeAsset) {
            return;
        }

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;

        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        this.digitCounts[asset][lastDigit]++;

        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return;
        }

        // While a session takeProfit pause is active, do not trade at all.
        if (this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        // Random asset selection: pick a fresh asset from the eligible pool
        // each time (suspended assets excluded). In single-active-asset mode
        // we only ever trade the one asset we subscribed to this cycle.
        const tradeAsset = this.config.singleActiveAsset
            ? this.activeAsset
            : (this.config.randomAssetSelection ? this.pickRandomAsset() : asset);
        if (tradeAsset) this.analyzeTicks(tradeAsset);
    }

    pickRandomAsset() {
        const pool = this.assets.filter(a =>
            !this.suspendedAssets.has(a) &&
            Array.isArray(this.tickHistories[a]) &&
            this.tickHistories[a].length >= this.config.requiredHistoryLength
        );
        if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
        // Everything is suspended — reactivate one so trading can continue.
        if (this.suspendedAssets.size) {
            const revived = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(revived);
            return revived;
        }
        return null;
    }

    // Single-active-asset mode: choose ONE random asset to subscribe to and
    // trade this cycle (no history requirement — we seed history on connect).
    _pickActiveAsset() {
        const pool = this.assets.filter(a => !this.suspendedAssets.has(a));
        if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
        if (this.suspendedAssets.size) {
            const revived = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(revived);
            return revived;
        }
        return this.assets[0] || null;
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return;
        }

        // Don't analyze suspended assets
        if (this.suspendedAssets.has(asset)) {
            console.log(`Skipping analysis for suspended asset: ${asset}`);
            return;
        }

        const history = this.tickHistories[asset];

        const lastDigit = history[history.length - 1];

        const predictedDigit = this.createRandomPrediction();

        // if(this.sys === 1) {
        //     if((predictedDigit == lastDigit ) || (predictedDigit === lastDigit + 1) || (predictedDigit === lastDigit - 1)) {
        //         this.xDigit = predictedDigit;
        //         this.placeTrade(asset, predictedDigit);
        //     }
        //     else{
        //         console.log(`[${asset}] Skipping trade for digit: ${predictedDigit} | Last Digit: ${lastDigit}`);
        //         this.disconnect();
        //     }
        // }
        // else {
        if ((predictedDigit !== lastDigit) && (predictedDigit !== lastDigit + 1) && (predictedDigit !== lastDigit - 1)) {
            this.xDigit = predictedDigit;
            this.placeTrade(asset, predictedDigit);
        }
        // else
        //     {
        //         console.log(`[${asset}] Skipping trade for digit: ${predictedDigit} | Last Digit: ${lastDigit}`);
        //         this.disconnect();
        //     }
        // }
    }

    createRandomPrediction() {
        return crypto.randomInt(0, 10);
    }

    async placeTrade(asset, predictedDigit) {
        if (this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`[${asset}] 🚀 Placing trade for digit: ${predictedDigit} | Stake: ${this.currentStake.toFixed(2)}`);
        try {
            const symbolField = this.client.symbolField();
            const proposalRes = await this.client._send({
                proposal: 1,
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: this.currency,
                duration: 1,
                duration_unit: 't',
                barrier: predictedDigit.toString(),
                [symbolField]: asset
            }, 15000);

            const proposal = proposalRes && proposalRes.proposal;
            if (!proposal || !proposal.id) {
                throw new Error('No proposal id returned');
            }

            const buyRes = await this.client._send({
                buy: proposal.id,
                price: Number(proposal.ask_price || this.currentStake)
            }, 15000);

            const buy = buyRes && buyRes.buy;
            if (!buy || !buy.contract_id) {
                throw new Error('Buy returned no contract_id');
            }

            console.log('Trade placed successfully');
            this.currentTradeId = buy.contract_id;
            this.currentAsset = asset;
            this.lastOpenStake = Number(proposal.ask_price || this.currentStake);
            this.lastOpenDigits = (this.tickHistories[asset] || []).slice(-10);
            // Remember the in-flight contract so a restart / network drop can
            // reconcile its result instead of losing it (persisted below).
            this.pendingContractId = this.currentTradeId;
            this.pendingContractAsset = asset;
            this.pendingContractDigit = predictedDigit;
            this._save('trade-open');
            this.sendTradeOpenNotification(asset, predictedDigit, this.lastOpenStake, Number(proposal.payout || 0));
            await this.subscribeToOpenContract(this.currentTradeId);
        } catch (e) {
            console.error('Error placing trade:', e.message);
            this.tradeInProgress = false;
        }
    }

    async subscribeToOpenContract(contractId) {
        try {
            await this.client.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg) => {
                const contract = msg.proposal_open_contract;
                if (contract) this.handleContractUpdate(contract);
            }, 15000);
            // The first response resolves the subscribe request and never reaches
            // the callback above. A 1-tick contract can already be sold in it, so
            // poll once after a short delay to catch that settlement (no-op if the
            // live subscription already reported it).
            setTimeout(() => {
                this.client._send({ proposal_open_contract: 1, contract_id: contractId }, 15000)
                    .then(res => {
                        const contract = res && res.proposal_open_contract;
                        if (contract) this.handleContractUpdate(contract);
                    })
                    .catch(() => {});
            }, 2000);
        } catch (e) {
            console.warn(`Failed to subscribe to open contract #${contractId}:`, e.message);
        }
    }

    handleContractUpdate(contract) {
        const contractId = contract.contract_id;
        if (contract.is_sold && !this.settledContracts.has(contractId)) {
            this.settledContracts.add(contractId);
            if (this.settledContracts.size > 5000) {
                const first = this.settledContracts.values().next().value;
                this.settledContracts.delete(first);
            }
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = this.currentAsset || contract.underlying || contract.symbol;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Suspend the asset after a loss
            // this.suspendAsset(asset);

            if (this.sys === 1) {
                this.sys = 2;
            } else {
                this.sys = 1;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        this.totalProfitLoss += profit;
        this.todayPnL += profit;
        this.Pause = true;

        // ── session tracking + durable checkpoint ───────────────────────
        this._sessionPL += profit;
        this._sessionTrades++;
        this._trackDaily(asset, contract, won, profit);
        // Contract settled — clear the in-flight marker and persist the result
        // so a restart/network drop never loses this trade.
        this.pendingContractId = null;
        this.pendingContractAsset = null;
        this.pendingContractDigit = null;
        this._save('after-trade');

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        this.sendTradeResultNotification(asset, contract, won, profit);

        this.logTradingSummary(asset);

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 3) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // Suspend the asset after a trade — optional (SUSPEND_AFTER_TRADE).
        if (this.config.suspendAssetAfterTrade) {
            this.suspendAsset(asset);
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.stopTrading();
            return;
        }

        // Session takeProfit: pause with a random cooldown, then start a new
        // session. Lifetime P/L is never reset by a session rollover.
        if (this.config.takeProfit > 0 && this._sessionPL >= this.config.takeProfit) {
            console.log(`Session takeProfit hit — session #${this._sessionNum} P/L ${this._sessionPL.toFixed(2)}. Pausing.`);
            this.sendTelegramSummary();
            this._pauseForTakeProfit();
            this.disconnect();
            return;
        }

        // this.unsubscribeAllTicks();
        this.disconnect();

        if (!this.endOfDay) {
            const nextTradeAfter = randomWaitTime;
            console.log(`Reconnecting in ${(nextTradeAfter / 1000).toFixed(0)}s...`);
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                // Fresh random pick per TRADE (not per session): clear the
                // previous cycle's asset so handleAuthorized must select a new
                // one on reconnect and subscribe only to it.
                if (this.config.singleActiveAsset) {
                    this.activeAsset = null;
                    console.log('🎲 Next trade: fresh random asset will be picked on reconnect');
                }
                // resume() (not connect()) so auto-reconnect stays armed for
                // any network/server drop after this manual cycle.
                this.client.resume();
            }, nextTradeAfter);
        }
    }

    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
    }

    // ── Session takeProfit: random cooldown, then a fresh session ───────
    _randomCooldownMs() {
        const min = Math.max(0, Number(this.config.takeProfitCooldownMinMs) || 0);
        const max = Math.max(min, Number(this.config.takeProfitCooldownMaxMs) || min);
        if (!(max > min)) return min;
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    _sessionLine() {
        const target = this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : '∞';
        return '🚀 Session #' + this._sessionNum + ': $' + this._sessionPL.toFixed(2) + ' / ' + target;
    }

    _pauseForTakeProfit() {
        if (this._tpAwaiting) return;
        this._tpAwaiting = true;
        const cooldownMs = this._randomCooldownMs();
        this._tpPauseUntil = Date.now() + cooldownMs;
        const mins = Math.max(1, Math.round(cooldownMs / 60000));
        logger.warn(`session takeProfit ${this.config.takeProfit} hit — session #${this._sessionNum} paused for ${mins} min (random)`);
        telegram.send(
            '🎯 <b>SESSION TAKE PROFIT HIT</b> — Session #' + this._sessionNum + '\n\n' +
            'Session P/L: <b>$' + this._sessionPL.toFixed(2) + '</b> (target $' + this.config.takeProfit.toFixed(2) + ')\n' +
            'Trades this session: ' + this._sessionTrades + '\n' +
            '💼 Lifetime P/L: <b>$' + this.totalProfitLoss.toFixed(2) + '</b>\n\n' +
            '⏸ Trading paused until <b>' + new Date(this._tpPauseUntil).toUTCString() + '</b> (~' + mins + ' min, random cooldown)\n' +
            '🕒 ' + utcTs(),
            'high'
        );
        this._save('tp-pause');
    }

    _checkTpResume() {
        if (this._tpAwaiting && Date.now() >= this._tpPauseUntil) this._startNewSession('timer');
    }

    _startNewSession(reason = 'cooldown elapsed') {
        if (!this._tpAwaiting) return;
        this._sessionNum++;
        this._sessionStartAt = Date.now();
        this._sessionStartBal = this.client.balance != null ? this.client.balance : 0;
        this._sessionPL = 0;
        this._sessionTrades = 0;
        this._tpAwaiting = false;
        this._tpPauseUntil = 0;
        logger.warn(`takeProfit cooldown over — new session #${this._sessionNum} started (${reason})`);
        telegram.send(
            '🚀 <b>NEW SESSION #' + this._sessionNum + '</b>\n\n' +
            'takeProfit cooldown ended (' + reason + '). Trading resumes — session P/L reset.\n' +
            'Start balance: <b>$' + (this._sessionStartBal || 0).toFixed(2) + '</b> | Target: ' +
            (this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : '∞') + '\n' +
            '💼 Lifetime P/L carried over: <b>$' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '🕒 ' + utcTs(),
            'high'
        );
        this._save('session-start');
        this.tradeInProgress = false;
        this.Pause = false;
        this.client.resume();
    }

    // ── Reconcile a contract left open across a restart / network drop ──
    async _reconcilePendingContract() {
        const cid = this.pendingContractId;
        if (!cid || this.settledContracts.has(cid)) return;
        logger.info(`reconcile pending contract #${cid} after (re)connect`);
        try {
            const res = await this.client._send({ proposal_open_contract: 1, contract_id: cid }, 15000);
            const c = res && res.proposal_open_contract;
            if (c && c.is_sold) {
                this.currentAsset = this.pendingContractAsset || this.currentAsset;
                if (this.pendingContractDigit != null) this.xDigit = this.pendingContractDigit;
                this.handleContractUpdate(c);
                return;
            }
            if (c) {
                this.currentAsset = this.pendingContractAsset || this.currentAsset;
                await this.subscribeToOpenContract(cid);
            }
            // Unconfirmed — keep pendingContractId so a later reconnect retries.
        } catch (e) {
            logger.warn(`reconcile #${cid} failed:`, e.message);
        }
    }

    // ── State persistence — survive restart / server & network drops ────
    _save(reason) {
        try {
            const f = this.stateFile, tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                version: 1, savedAt: new Date().toISOString(), reason,
                totalTrades: this.totalTrades, totalWins: this.totalWins, totalLosses: this.totalLosses,
                consecutiveLosses: this.consecutiveLosses,
                consecutiveLosses2: this.consecutiveLosses2, consecutiveLosses3: this.consecutiveLosses3,
                consecutiveLosses4: this.consecutiveLosses4, consecutiveLosses5: this.consecutiveLosses5,
                totalProfitLoss: this.totalProfitLoss, currentStake: this.currentStake,
                todayPnL: this.todayPnL,
                suspendedAssets: Array.from(this.suspendedAssets),
                settledContracts: Array.from(this.settledContracts).slice(-1000),
                dailyStats: this.dailyStats,
                hourlyStats: this.hourlyStats,
                startBalance: this.startBalance, lastBalance: this.client ? this.client.balance : null,
                sessionNum: this._sessionNum, sessionStartAt: this._sessionStartAt,
                sessionStartBal: this._sessionStartBal, sessionPL: this._sessionPL,
                sessionTrades: this._sessionTrades,
                tpAwaiting: this._tpAwaiting, tpPauseUntil: this._tpPauseUntil,
                pendingContractId: this.pendingContractId,
                pendingContractAsset: this.pendingContractAsset,
                pendingContractDigit: this.pendingContractDigit,
            }, null, 2));
            fs.renameSync(tmp, f);
        } catch (e) { logger.warn('save state:', e.message); }
    }

    _loadState() {
        const f = this.stateFile;
        if (!fs.existsSync(f)) return;
        try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Number.isFinite(Number(d.totalTrades))) this.totalTrades = Number(d.totalTrades);
            if (Number.isFinite(Number(d.totalWins))) this.totalWins = Number(d.totalWins);
            if (Number.isFinite(Number(d.totalLosses))) this.totalLosses = Number(d.totalLosses);
            if (Number.isFinite(Number(d.consecutiveLosses))) this.consecutiveLosses = Number(d.consecutiveLosses);
            if (Number.isFinite(Number(d.consecutiveLosses2))) this.consecutiveLosses2 = Number(d.consecutiveLosses2);
            if (Number.isFinite(Number(d.consecutiveLosses3))) this.consecutiveLosses3 = Number(d.consecutiveLosses3);
            if (Number.isFinite(Number(d.consecutiveLosses4))) this.consecutiveLosses4 = Number(d.consecutiveLosses4);
            if (Number.isFinite(Number(d.consecutiveLosses5))) this.consecutiveLosses5 = Number(d.consecutiveLosses5);
            if (Number.isFinite(Number(d.totalProfitLoss))) this.totalProfitLoss = Number(d.totalProfitLoss);
            if (Number.isFinite(Number(d.currentStake)) && Number(d.currentStake) > 0) this.currentStake = Number(d.currentStake);
            if (Number.isFinite(Number(d.todayPnL))) this.todayPnL = Number(d.todayPnL);
            if (Array.isArray(d.suspendedAssets)) this.suspendedAssets = new Set(d.suspendedAssets);
            if (Array.isArray(d.settledContracts)) this.settledContracts = new Set(d.settledContracts);
            if (d.dailyStats && typeof d.dailyStats === 'object') this.dailyStats = d.dailyStats;
            if (d.hourlyStats && typeof d.hourlyStats === 'object') this.hourlyStats = d.hourlyStats;
            if (d.startBalance != null) this.startBalance = Number(d.startBalance);
            if (Number.isFinite(Number(d.sessionNum))) this._sessionNum = Math.max(1, Number(d.sessionNum));
            if (Number.isFinite(Number(d.sessionStartAt))) this._sessionStartAt = Number(d.sessionStartAt);
            this._sessionStartBal = Number(d.sessionStartBal || 0);
            this._sessionPL = Number(d.sessionPL || 0);
            this._sessionTrades = Number(d.sessionTrades || 0);
            this._tpAwaiting = !!d.tpAwaiting;
            this._tpPauseUntil = Number(d.tpPauseUntil || 0);
            this.pendingContractId = d.pendingContractId || null;
            this.pendingContractAsset = d.pendingContractAsset || null;
            this.pendingContractDigit = d.pendingContractDigit != null ? Number(d.pendingContractDigit) : null;
            logger.info(
                `state restored: ${this.totalTrades} trades (✅${this.totalWins} ❌${this.totalLosses}) | ` +
                `P/L $${this.totalProfitLoss.toFixed(2)} | next stake $${this.currentStake.toFixed(2)} | ` +
                `${this._sessionLine()} | tpPause=${this._tpAwaiting}` +
                (this._tpAwaiting ? ' until ' + new Date(this._tpPauseUntil).toUTCString() : '') +
                (this.pendingContractId ? ` | pending #${this.pendingContractId}` : '')
            );
        } catch (e) { logger.warn('load state:', e.message); }
    }

    stop(sig = 'shutdown') {
        if (this._stopped) return;
        this._stopped = true;
        logger.info(`stopping (${sig})`);
        if (this._tpResumeT) clearInterval(this._tpResumeT);
        if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
        if (this._hourlyT) clearInterval(this._hourlyT);
        if (this._eodBoot) clearTimeout(this._eodBoot);
        this._save('shutdown');
        this.client.stop();
        setTimeout(() => process.exit(0), 1500);
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            this.client.forget(subId);
        });
        this.tickSubscriptionIds = {};
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        // Set start time when first connecting
        if (!this.startTime) {
            this.startTime = new Date();
            console.log(`Bot started at: ${this.startTime.toLocaleTimeString()}`);
        }

        setInterval(() => {
            const now = new Date();
            const elapsedHours = (now - this.startTime) / (1000 * 60 * 60); // Convert to hours

            // Check if 2 hours have elapsed
            // if (elapsedHours >= 2 && this.isWinTrade) {
            //     console.log(`2 hours of trading completed. Started at ${this.startTime.toLocaleTimeString()}, stopping now at ${now.toLocaleTimeString()}`);
            //     this.Pause = true;
            //     this.unsubscribeAllTicks();
            //     this.disconnect();
            //     this.endOfDay = true;
            //     return;
            // }

            // Optional: Log remaining time every interval
            if (!this.endOfDay) {
                const remainingMins = Math.max(0, 120 - (elapsedHours * 60));
                // console.log(`Time remaining: ${remainingMins.toFixed(0)} minutes`);
            }

            // Reset for next day
            // const currentHours = now.getHours();
            // const currentMinutes = now.getMinutes();

            // if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
            //     console.log("It's 8:00 AM, reconnecting the bot for a new session.");
            //     this.startTime = new Date(); // Reset start time
            //     this.assets.forEach(asset => {
            //         this.lastPredictions[asset] = [];
            //     });
            //     this.Pause = false;
            //     this.endOfDay = false;
            //     this.connect();
            // }
        }, 20000); // Check every 20 seconds
    }

    disconnect() {
        this.client.suspend();
    }

    stopTrading() {
        this._save('stop-trading');
        this.client.stop();
    }

    logTradingSummary(asset) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.xDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }

    startTelegramTimer() {
        if (!this.endOfDay) {
            // Align to the top of the GMT hour (same scheduling as randomDigitDifferV2.js)
            const now = new Date();
            const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
            this._hourlyBoot = setTimeout(() => {
                this._sendHourly();
                this._hourlyT = setInterval(() => this._sendHourly(), 3600_000); // 1 hour
            }, Math.max(1000, msToNextHour));
        }
    }

    // ── Hourly trade summary (GMT), mirrors randomDigitDifferV2.js ─────
    _sendHourly() {
        const now = new Date();
        const prev = new Date(now.getTime() - 3600_000);
        const date = this._dayKey(prev);
        const hour = prev.getUTCHours();
        const bucket = this.hourlyStats[date + '|' + pad(hour)];
        const h = bucket || { trades: 0, wins: 0, losses: 0, netPL: 0 };
        const winRateLifetime = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const sessLine = this._tpAwaiting
            ? '⏸ ' + this._sessionLine() + ' — paused until ' + new Date(this._tpPauseUntil).toUTCString()
            : this._sessionLine();

        if (!h.trades) {
            telegram.send(
                '⏰ <b>Random Digit Multi-Asset Bot — Hourly Summary GMT (' + date + ' ' + pad(hour) + ':00-' + pad(hour) + ':59)</b>\n\n' +
                'No trades this hour.\n\n' +
                '📊 Trades: ' + this.totalTrades + ' (✅' + this.totalWins + ' ❌' + this.totalLosses + ') | WR ' + winRateLifetime + '%\n' +
                sessLine + '\n' +
                '💼 Overall P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
                '🕒 ' + utcTs(),
                'high'
            );
            return;
        }

        const hWR = ((h.wins / h.trades) * 100).toFixed(1);
        let msg =
            '⏰ <b>Random Digit Multi-Asset Bot — Hourly Summary GMT (' + date + ' ' + pad(hour) + ':00-' + pad(hour) + ':59)</b>\n\n' +
            '📊 Trades: ' + h.trades + ' (✅' + h.wins + ' ❌' + h.losses + ') | WR ' + hWR + '%\n' +
            '💰 P/L: <b>' + (h.netPL >= 0 ? '+' : '') + h.netPL.toFixed(2) + '</b>\n' +
            sessLine + '\n' +
            '💼 Overall P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '📊 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses + ') | WR ' + winRateLifetime + '%\n' +
            '❌ Streaks: x2=' + this.consecutiveLosses2 + ' x3=' + this.consecutiveLosses3 + ' x4=' + this.consecutiveLosses4 + ' x5=' + this.consecutiveLosses5 + '\n\n' +
            '📋 Detail:\n';

        bucket.list.slice(-20).forEach((t, i) => {
            msg += (i + 1) + '. ' + (t.won ? '✅' : '❌') + ' #' + (t.cid != null ? t.cid : '?') + ' ' + htmlEscape(t.asset) + ' d' + t.digit + ' ' + (t.profit >= 0 ? '+' : '') + t.profit.toFixed(2) + '\n';
        });
        telegram.send(msg, 'high');
    }

    _dayKey(date = new Date()) {
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }

    _trackDaily(asset, contract, won, profit) {
        const key = this._dayKey();
        if (!this.dailyStats[key]) {
            this.dailyStats[key] = { trades: 0, wins: 0, losses: 0, netPL: 0, stakes: 0, list: [] };
        }
        const d = this.dailyStats[key];
        d.trades++;
        if (won) d.wins++; else d.losses++;
        d.netPL += profit;
        d.stakes += this.lastOpenStake || Number(contract.stake) || this.currentStake;
        d.list.push({ asset, won, profit, digit: this.xDigit, cid: contract.contract_id });
        if (d.list.length > 50) d.list.shift();

        const now = new Date();
        const hkey = key + '|' + pad(now.getUTCHours());
        if (!this.hourlyStats[hkey]) {
            this.hourlyStats[hkey] = { trades: 0, wins: 0, losses: 0, netPL: 0, stakes: 0, list: [] };
        }
        const h = this.hourlyStats[hkey];
        h.trades++;
        if (won) h.wins++; else h.losses++;
        h.netPL += profit;
        h.stakes += this.lastOpenStake || Number(contract.stake) || this.currentStake;
        h.list.push({ asset, won, profit, digit: this.xDigit, cid: contract.contract_id });
        if (h.list.length > 50) h.list.shift();

        const cutoff = this._dayKey(new Date(now.getTime() - 48 * 3600_000));
        for (const bk of Object.keys(this.hourlyStats)) {
            if (bk < cutoff) delete this.hourlyStats[bk];
        }
    }

    _todayStats() {
        const d = this.dailyStats[this._dayKey()] || { trades: 0, wins: 0, losses: 0, netPL: 0 };
        return {
            trades: d.trades,
            wins: d.wins,
            losses: d.losses,
            netPL: d.netPL,
            winRate: d.trades ? ((d.wins / d.trades) * 100).toFixed(2) : '0.00'
        };
    }

    sendTelegramSummary() {
        const winRate = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        const today = this._todayStats();

        const summaryText =
            '📊 <b>Random Digit Multi-Asset Bot — Summary</b>\n' +
            'Total Trades: ' + this.totalTrades + ' | ✅ ' + this.totalWins + ' | ❌ ' + this.totalLosses + '\n' +
            'x2 Losses: ' + this.consecutiveLosses2 + ' | x3: ' + this.consecutiveLosses3 +
            ' | x4: ' + this.consecutiveLosses4 + ' | x5: ' + this.consecutiveLosses5 + '\n\n' +
            '📅 Today (UTC ' + this._dayKey() + '): ' + today.trades + ' trades (✅' + today.wins + ' ❌' + today.losses +
            ') | P/L <b>' + today.netPL.toFixed(2) + '</b>\n\n' +
            'Currently Suspended Assets: <code>' + (Array.from(this.suspendedAssets).join(', ') || 'None') + '</code>\n\n' +
            'Current Stake: <b>$' + this.currentStake.toFixed(2) + '</b>\n' +
            'Total Profit/Loss Amount: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            'Win Rate: <b>' + winRate + '%</b>\n' +
            '🕒 ' + utcTs();

        telegram.send(summaryText, 'high');
    }

    sendTradeOpenNotification(asset, digit, stake, payout) {
        const last10 = this.lastOpenDigits && this.lastOpenDigits.length ? this.lastOpenDigits.join(', ') : (this.tickHistories[asset] || []).slice(-10).join(', ') || '—';

        telegram.send(
            '🟢 <b>Random Digit Multi-Asset Bot — OPEN</b>\n' +
            'Asset: <code>' + htmlEscape(asset) + '</code>\n' +
            'Predicted digit: <b>' + digit + '</b>\n' +
            'Stake: <b>$' + stake.toFixed(2) + '</b> → payout ' + (payout ? payout.toFixed(2) : '—') + '\n\n' +
            'Last 10 digits: <code>' + last10 + '</code>\n' +
            '🕒 ' + utcTs(),
            'low'
        );
    }

    sendTradeResultNotification(asset, contract, won, profit) {
        const winRate = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        const history = this.tickHistories[asset] || [];
        const lastFewTicks = history.slice(-20);
        const tradeId = contract.contract_id;

        const summaryText =
            (won ? '✅ <b>Random Digit Multi-Asset Bot — WIN</b>' : '❌ <b>Random Digit Multi-Asset Bot — LOSS</b>') + '\n\n' +
            'Trade #' + tradeId + '\n' +
            'Asset: <code>' + htmlEscape(asset) + '</code>\n' +
            'Predicted digit: <b>' + this.xDigit + '</b>\n' +
            'Result P/L: <b>' + (won ? '+' : '') + profit.toFixed(2) + '</b>\n\n' +
            'Total Trades: ' + this.totalTrades + ' | ✅ ' + this.totalWins + ' | ❌ ' + this.totalLosses + '\n' +
            'Win Rate: <b>' + winRate + '%</b>\n' +
            'Total P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n\n' +
            'Last 20 digits: <code>' + (lastFewTicks.join(', ') || '—') + '</code>\n\n' +
            'Current Stake: <b>$' + this.currentStake.toFixed(2) + '</b>\n' +
            'Waiting for: ' + this.waitTime + ' (' + this.waitSeconds + ' ms)  before next trade...\n' +
            '🕒 ' + utcTs();

        telegram.send(summaryText, won ? 'low' : 'high');
    }

    sendErrorNotification(errorMessage) {
        telegram.send(
            '🚨 <b>Random Digit Multi-Asset Bot — Error</b>\n\n' +
            'An error occurred: ' + errorMessage + '\n' +
            '🕒 ' + utcTs(),
            'high'
        );
    }

    // ── End-of-Day summary (GMT) ───────────────────────────────────────
    _msToNextEod(now = new Date()) {
        const [h, min] = String(this.eodTimeGmt || '00:00').split(':').map(Number);
        const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h || 0, min || 0, 0, 0));
        if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
        return target.getTime() - now.getTime();
    }
    _eodReportDate(now = new Date()) {
        // Report the trade day that just closed (roll back past the trigger moment).
        return this._dayKey(new Date(now.getTime() - 60 * 1000));
    }
    _scheduleEod() {
        const delay = this._msToNextEod();
        console.log(`Next GMT EOD report in ${(delay / 3600000).toFixed(2)}h`);
        this._eodBoot = setTimeout(() => {
            this._sendEod();
            this._scheduleEod();
        }, delay);
    }
    _sendEod() {
        const date = this._eodReportDate();
        const d = this.dailyStats[date] || { trades: 0, wins: 0, losses: 0, netPL: 0, list: [] };
        const winRate = d.trades ? ((d.wins / d.trades) * 100).toFixed(2) : '0.00';

        let msg = '🌙 <b>Random Digit Multi-Asset Bot — END OF TRADE DAY</b>\n' +
            '📅 Trade day (UTC): <b>' + date + '</b>\n\n';

        if (d.trades === 0) {
            msg += 'No trades recorded for this trade day.\n\n';
        } else {
            msg += '📊 Trades: ' + d.trades + ' (✅' + d.wins + ' ❌' + d.losses + ') | WR <b>' + winRate + '%</b>\n' +
                '💰 Net P/L: <b>' + (d.netPL >= 0 ? '+' : '') + d.netPL.toFixed(2) + '</b>\n\n';

            if (d.list.length) {
                msg += '📋 Trades:\n';
                d.list.slice(-25).forEach((t, i) => {
                    msg += (i + 1) + '. ' + (t.won ? '✅' : '❌') + ' <code>' + htmlEscape(t.asset) + '</code> d' + t.digit + ' ' + (t.profit >= 0 ? '+' : '') + t.profit.toFixed(2) + '\n';
                });
            }
        }

        msg += '\n💼 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses +
            ') | Net P/L <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '🕒 ' + utcTs();

        telegram.send(msg, 'high');
        this._save(`eod-${date}`);
    }

    start() {
        console.log('Asset mode: ' + (this.config.singleActiveAsset ? 'ONE asset per cycle (random pick, lowest latency)' : 'ALL assets subscribed'));
        console.log('Random asset selection: ' + (this.config.randomAssetSelection ? 'ON' : 'OFF (tick-driven)'));
        console.log('Suspend asset after trade: ' + (this.config.suspendAssetAfterTrade ? 'ON' : 'OFF'));
        console.log(`Session takeProfit: ${this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : 'OFF'} | cooldown ${Math.round(this.config.takeProfitCooldownMinMs / 60000)}-${Math.round(this.config.takeProfitCooldownMaxMs / 60000)} min (random)`);
        console.log('State file: ' + this.stateFile);

        this.connect();
        this.checkTimeForDisconnectReconnect();
        this._scheduleEod();
        this._tpResumeT = setInterval(() => this._checkTpResume(), 10000);

        process.on('SIGINT', () => this.stop('SIGINT'));
        process.on('SIGTERM', () => this.stop('SIGTERM'));
        process.on('uncaughtException', (e) => { logger.error('uncaught:', e); this._save('uncaught'); });
        process.on('unhandledRejection', (e) => { logger.error('unhandled:', e); this._save('unhandled'); });
    }
}

// Usage — trading config preserved from the original randomDiffer.js
const bot = new EnhancedDigitDifferTradingBot({
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 25,              // per-session profit target (0 = off)
    requiredHistoryLength: 1000,
    winProbabilityThreshold: 100,
    minWaitTime: 12000,
    maxWaitTime: 120000,
    minOccurrencesThreshold: 1,
    assets: [
        'R_10','R_25','R_50','R_75', 'RDBULL', 'RDBEAR', 
        '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 
        'JD10', 'JD25', 'JD50', 'JD75', 'JD100'
    ],
    // singleActiveAsset (ONE_ASSET_AT_A_TIME, default true): subscribes to and
    // trades one randomly selected asset per cycle for lowest latency.
    // randomAssetSelection / suspendAssetAfterTrade / cooldown default from
    // CONFIG (env RANDOM_ASSET_SELECTION, SUSPEND_AFTER_TRADE,
    // TAKE_PROFIT_COOLDOWN_MS_MIN/MAX). Pass explicit booleans here to override.
});

bot.start();
