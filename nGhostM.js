#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v3.0 Multi-Asset + State Persistence
//  Deriv Digit Differ — HMM + CUSUM + Bayesian Regime Detection
//
//  NEW IN v3.0:
//    1. Multi-asset trading (R_10, R_25, R_50, R_75, R_100, RDBULL, RDBEAR)
//    2. Per-asset HMM regime detectors (each asset gets its own model)
//    3. Per-asset tick histories, ghost state, and signal tracking
//    4. State persistence (auto-saves every 5s, restores on restart)
//    5. Hourly Telegram summaries
//    6. Asset suspension system (suspend losing asset briefly)
//    7. Weekend detection & daily schedule management
//    8. One global trade lock (only one asset trades at a time)
//
//  REGIME DETECTION (unchanged from v2):
//    1. True 2-State HMM with Viterbi decoding (REP / NON-REP regimes)
//    2. Baum-Welch parameter estimation
//    3. CUSUM change-point detection
//    4. Bayesian posterior regime probability
//    5. Forward algorithm for real-time updates
//    6. Regime persistence scoring
//
//  Usage:
//    node romanian-ghost-bot-v3.js
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ── Credentials ───────────────────────────────────────────────────────────────
const TOKEN         = '0P94g4WdSrSrzir';
const TELEGRAM_TOKEN = '8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8';
const CHAT_ID       = '752497117';

// ── ANSI Colour Helpers ───────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m', white: '\x1b[37m',
};
const col    = (text, ...codes) => codes.join('') + text + C.reset;
const bold   = t => col(t, C.bold);
const dim    = t => col(t, C.dim);
const cyan   = t => col(t, C.cyan);
const blue   = t => col(t, C.blue);
const green  = t => col(t, C.green);
const red    = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta = t => col(t, C.magenta);

// ── Logger ─────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: cyan, API: blue, TICK: dim, ANALYSIS: yellow,
    GHOST: magenta, TRADE: bold, RESULT: bold, RISK: red,
    STATS: cyan, ERROR: t => col(t, C.bold, C.red), HMM: t => col(t, C.orange),
    PERSIST: t => col(t, C.blue),
};

function getTimestamp() {
    const n = new Date();
    return [n.getHours(), n.getMinutes(), n.getSeconds()]
        .map(v => String(v).padStart(2, '0')).join(':');
}

function log(prefix, message) {
    const ts  = dim(`[${getTimestamp()}]`);
    const pfx = (PREFIX_COLOURS[prefix] || (t => t))(`[${prefix}]`);
    console.log(`${ts} ${pfx} ${message}`);
}

const logBot      = m => log('BOT', m);
const logApi      = m => log('API', m);
const logTick     = m => log('TICK', m);
const logAnalysis = m => log('ANALYSIS', m);
const logGhost    = m => log('GHOST', m);
const logTrade    = m => log('TRADE', m);
const logResult   = m => log('RESULT', m);
const logRisk     = m => log('RISK', m);
const logStats    = m => log('STATS', m);
const logError    = m => log('ERROR', m);
const logHMM      = m => log('HMM', m);
const logPersist  = m => log('PERSIST', m);

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac  = parts.length > 1 ? parts[1] : '';
    if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}

function formatMoney(v)    { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function clamp(v, lo, hi)  { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}
function formatDuration(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600),
          m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'ghost-bot-v3a-state.json');
const STATE_SAVE_INTERVAL = 5000;    // every 5 seconds
const STATE_MAX_AGE_MS    = 30 * 60 * 1000; // 30 minutes

class StatePersistence {
    static save(bot) {
        try {
            const state = {
                savedAt: Date.now(),
                session: {
                    sessionStartTime:  bot.sessionStartTime,
                    totalTrades:       bot.totalTrades,
                    totalWins:         bot.totalWins,
                    totalLosses:       bot.totalLosses,
                    sessionProfit:     bot.sessionProfit,
                    currentWinStreak:  bot.currentWinStreak,
                    currentLossStreak: bot.currentLossStreak,
                    maxWinStreak:      bot.maxWinStreak,
                    maxLossStreak:     bot.maxLossStreak,
                    largestWin:        bot.largestWin,
                    largestLoss:       bot.largestLoss,
                    maxMartingaleReached: bot.maxMartingaleReached,
                },
                martingale: {
                    martingaleStep:      bot.martingaleStep,
                    totalMartingaleLoss: bot.totalMartingaleLoss,
                    currentStake:        bot.currentStake,
                },
                perAsset: {},
            };

            // Per-asset state
            for (const asset of bot.assets) {
                const as = bot.assetState[asset];
                state.perAsset[asset] = {
                    tickHistory:         (as.tickHistory || []).slice(-500), // last 500
                    ghostConsecutiveWins: as.ghostConsecutiveWins,
                    ghostRoundsPlayed:    as.ghostRoundsPlayed,
                    ghostConfirmed:       as.ghostConfirmed,
                    targetDigit:          as.targetDigit,
                };
            }

            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } catch (e) {
            logError(`StatePersistence.save failed: ${e.message}`);
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                logPersist('No previous state file — starting fresh');
                return null;
            }
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMin = (Date.now() - data.savedAt) / 60000;
            if (Date.now() - data.savedAt > STATE_MAX_AGE_MS) {
                logPersist(`State file is ${ageMin.toFixed(1)}m old (>30m) — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return null;
            }
            logPersist(`Restoring state from ${ageMin.toFixed(1)}m ago`);
            return data;
        } catch (e) {
            logError(`StatePersistence.load failed: ${e.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => StatePersistence.save(bot), STATE_SAVE_INTERVAL);
        logPersist('Auto-save started (every 5s)');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  HMM REGIME DETECTOR (unchanged from v2 — one instance per asset)
// ══════════════════════════════════════════════════════════════════════════════

class HMMRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.pi  = [0.6, 0.4];
        this.A   = [[0.90, 0.10], [0.25, 0.75]];
        this.B   = [[0.92, 0.08], [0.40, 0.60]];
        this.logAlpha  = [Math.log(0.6), Math.log(0.4)];
        this.hmmFitted = false;
        this.cusumValue = new Array(10).fill(0);
    }

    baumWelch(obs, maxIter = 20, tol = 1e-5) {
        const T = obs.length;
        if (T < 10) return false;
        const N = 2;
        let pi = [...this.pi], A = this.A.map(r => [...r]), B = this.B.map(r => [...r]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            // Forward
            const logAlpha = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++)
                logAlpha[0][s] = Math.log(pi[s]+1e-300) + Math.log(B[s][obs[0]]+1e-300);
            for (let t = 1; t < T; t++)
                for (let s = 0; s < N; s++) {
                    const incoming = A.map((row, p) => logAlpha[t-1][p] + Math.log(row[s]+1e-300));
                    logAlpha[t][s] = logSumExp(incoming) + Math.log(B[s][obs[t]]+1e-300);
                }
            const logL = logSumExp(logAlpha[T-1]);

            // Backward
            const logBeta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T-1][s] = 0;
            for (let t = T-2; t >= 0; t--)
                for (let s = 0; s < N; s++) {
                    const vals = A[s].map((a, nx) =>
                        Math.log(a+1e-300) + Math.log(B[nx][obs[t+1]]+1e-300) + logBeta[t+1][nx]);
                    logBeta[t][s] = logSumExp(vals);
                }

            // Gamma
            const logGamma = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const denom = logSumExp(logAlpha[t].map((la,s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - denom;
            }

            // Xi
            const logXi = Array.from({length: T-1}, () =>
                Array.from({length: N}, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T-1; t++) {
                const denom = logSumExp(logAlpha[t].map((la,s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++)
                    for (let nx = 0; nx < N; nx++)
                        logXi[t][s][nx] = logAlpha[t][s] + Math.log(A[s][nx]+1e-300) +
                            Math.log(B[nx][obs[t+1]]+1e-300) + logBeta[t+1][nx] - denom;
            }

            // M-step
            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi.reduce((a,b) => a+b, 0);
            pi = pi.map(v => v/piSum);

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0,T-1).map(g => g[s]));
                for (let nx = 0; nx < N; nx++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][nx]));
                    A[s][nx] = Math.exp(numer - denom);
                }
                const rowSum = A[s].reduce((a,b) => a+b, 0);
                A[s] = A[s].map(v => v/rowSum);
            }

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < 2; o++) {
                    const numer = logSumExp(logGamma.filter((_,t) => obs[t]===o).map(g => g[s]));
                    B[s][o] = Math.exp(numer - denom);
                }
                const bSum = B[s].reduce((a,b) => a+b, 0);
                B[s] = B[s].map(v => v/bSum);
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Ensure state 0 = NON-REP (lower repeat emission)
        if (B[0][1] > B[1][1]) {
            [pi[0],pi[1]] = [pi[1],pi[0]];
            [A[0],A[1]]   = [A[1],A[0]];
            A[0] = [A[0][1],A[0][0]]; A[1] = [A[1][1],A[1][0]];
            [B[0],B[1]]   = [B[1],B[0]];
        }

        this.pi = pi; this.A = A; this.B = B;
        this.hmmFitted = true;
        return true;
    }

    viterbi(obs) {
        const T = obs.length, N = 2;
        if (T === 0) return null;
        const logDelta = Array.from({length:T}, () => new Array(N).fill(-Infinity));
        const psi      = Array.from({length:T}, () => new Array(N).fill(0));

        for (let s = 0; s < N; s++)
            logDelta[0][s] = Math.log(this.pi[s]+1e-300) + Math.log(this.B[s][obs[0]]+1e-300);

        for (let t = 1; t < T; t++)
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bestPrev = 0;
                for (let p = 0; p < N; p++) {
                    const v = logDelta[t-1][p] + Math.log(this.A[p][s]+1e-300);
                    if (v > best) { best = v; bestPrev = p; }
                }
                logDelta[t][s] = best + Math.log(this.B[s][obs[t]]+1e-300);
                psi[t][s] = bestPrev;
            }

        const stateSeq = new Array(T);
        stateSeq[T-1] = logDelta[T-1][0] >= logDelta[T-1][1] ? 0 : 1;
        for (let t = T-2; t >= 0; t--) stateSeq[t] = psi[t+1][stateSeq[t+1]];

        const curState = stateSeq[T-1];
        let persistence = 1;
        for (let t = T-2; t >= 0; t--) {
            if (stateSeq[t] === curState) persistence++; else break;
        }
        let transitions = 0;
        for (let t = 1; t < T; t++) if (stateSeq[t] !== stateSeq[t-1]) transitions++;

        return { stateSeq, currentState: curState, persistence, transitions };
    }

    updateCUSUM(digit, obs_t) {
        const logLR = Math.log(this.B[1][obs_t]+1e-300) - Math.log(this.B[0][obs_t]+1e-300);
        this.cusumValue[digit] = Math.max(0, this.cusumValue[digit] + logLR - this.cfg.cusum_slack);
        return this.cusumValue[digit] > this.cfg.cusum_threshold;
    }

    resetCUSUM(digit) { this.cusumValue[digit] = 0; }

    computePerDigitStats(window) {
        const len = window.length;
        const ALPHA = 0.15;
        const ewmaRepeat   = new Array(10).fill(null);
        const transFrom    = new Array(10).fill(0);
        const transRepeat  = new Array(10).fill(0);

        for (let i = 0; i < len; i++) {
            const d = window[i];
            const isRepeat = i > 0 && window[i] === window[i-1];
            ewmaRepeat[d] = ewmaRepeat[d] === null
                ? (isRepeat ? 100 : 0)
                : ALPHA * (isRepeat ? 100 : 0) + (1-ALPHA) * ewmaRepeat[d];
        }
        for (let i = 0; i < len-1; i++) {
            transFrom[window[i]]++;
            if (window[i+1] === window[i]) transRepeat[window[i]]++;
        }
        const rawRepeatProb = transFrom.map((tf, d) =>
            tf > 0 ? (transRepeat[d] / tf) * 100 : 10);
        ewmaRepeat.forEach((v,i) => { if (v === null) ewmaRepeat[i] = 10; });
        return { rawRepeatProb, ewmaRepeat };
    }

    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;
        if (len < this.cfg.min_ticks_for_hmm) return { valid: false, reason: 'insufficient data' };

        const obs = new Array(len-1);
        for (let t = 1; t < len; t++) obs[t-1] = window[t] === window[t-1] ? 1 : 0;

        if (!this.hmmFitted || tickHistory.length % 50 === 0) {
            const fitted = this.baumWelch(obs);
            if (fitted) {
                logHMM(
                    `📐 HMM params | A: NR→R=${(this.A[0][1]*100).toFixed(1)}% ` +
                    `R→NR=${(this.A[1][0]*100).toFixed(1)}% | ` +
                    `B(rep|NR)=${(this.B[0][1]*100).toFixed(1)}% B(rep|R)=${(this.B[1][1]*100).toFixed(1)}%`
                );
            }
        }

        const vit = this.viterbi(obs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        // Forward (Bayesian posterior)
        let logA = [Math.log(this.pi[0]+1e-300), Math.log(this.pi[1]+1e-300)];
        logA[0] += Math.log(this.B[0][obs[0]]+1e-300);
        logA[1] += Math.log(this.B[1][obs[0]]+1e-300);
        for (let t = 1; t < obs.length; t++) {
            const newA = [0,1].map(s => logSumExp(
                [0,1].map(p => logA[p] + Math.log(this.A[p][s]+1e-300))
            ) + Math.log(this.B[s][obs[t]]+1e-300));
            logA = newA;
        }
        const denom = logSumExp(logA);
        const posteriorNonRep = Math.exp(logA[0] - denom);
        const posteriorRep    = Math.exp(logA[1] - denom);

        // CUSUM (recent 30 ticks for target digit)
        const recentWindow = window.slice(-30);
        let cusumAlarm = false;
        for (let t = 1; t < recentWindow.length; t++) {
            const obs_t = recentWindow[t] === recentWindow[t-1] ? 1 : 0;
            if (recentWindow[t-1] === targetDigit || recentWindow[t] === targetDigit)
                cusumAlarm = this.updateCUSUM(targetDigit, obs_t);
        }

        const { rawRepeatProb, ewmaRepeat } = this.computePerDigitStats(window);

        // Recent repeat rate (last 20)
        const sw = window.slice(-20);
        let recentRepeatCount = 0, recentTotal = 0;
        for (let i = 1; i < sw.length; i++) {
            if (sw[i-1] === targetDigit || sw[i] === targetDigit) {
                recentTotal++;
                if (sw[i] === sw[i-1]) recentRepeatCount++;
            }
        }
        const recentRepeatRate = recentTotal > 0
            ? (recentRepeatCount / recentTotal) * 100
            : rawRepeatProb[targetDigit];

        // Stability across 5 segments
        const seqLen  = vit.stateSeq.length;
        const segSize = Math.floor(seqLen / 5);
        const segmentStates = [];
        for (let seg = 0; seg < 5 && seg*segSize < seqLen; seg++) {
            const slice = vit.stateSeq.slice(seg*segSize, (seg+1)*segSize);
            segmentStates.push(slice.filter(s => s===0).length / slice.length);
        }
        const regimeStability = segmentStates.reduce((a,b) => a+b, 0) / segmentStates.length;

        // Composite safety score
        const threshold = this.cfg.repeat_threshold;
        let safetyScore = 0;
        if (vit.currentState === 0) safetyScore += 40;
        safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 30);
        const persistenceScore = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
        safetyScore += Math.round(persistenceScore * 15);
        safetyScore += Math.round(regimeStability * 15);

        if (vit.currentState !== 0) safetyScore = 0;
        if (posteriorNonRep < this.cfg.hmm_nonrep_confidence) safetyScore = Math.min(safetyScore, 40);
        if (rawRepeatProb[targetDigit] >= threshold) safetyScore = 0;
        if (cusumAlarm) safetyScore = 0;

        const signalActive = (
            vit.currentState === 0 &&
            posteriorNonRep >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            rawRepeatProb[targetDigit] < threshold &&
            ewmaRepeat[targetDigit] < threshold &&
            !cusumAlarm &&
            safetyScore >= this.cfg.repeat_confidence
        );

        return {
            valid: true,
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            regimeStability,
            posteriorNonRep,
            posteriorRep,
            cusumAlarm,
            cusumValue: this.cusumValue[targetDigit],
            rawRepeatProb,
            ewmaRepeat,
            recentRepeatRate,
            hmmA: this.A,
            hmmB: this.B,
            safetyScore,
            signalActive,
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════

function buildConfig() {
    return {
        // Connection
        api_token:   TOKEN,
        app_id:      '1089',
        endpoint:    'wss://ws.derivws.com/websockets/v3',

        // Assets to monitor
        assets: ['R_10','R_25','R_50','R_75','RDBULL','RDBEAR'],

        // History
        tick_history_size:   5000,
        analysis_window:     5000,
        min_ticks_for_hmm:   50,

        // Regime detection
        repeat_threshold:        8,
        repeat_confidence:       90,
        hmm_nonrep_confidence:   0.93,
        min_regime_persistence:  8,
        cusum_threshold:         4.5,
        cusum_slack:             0.005,

        // Ghost trading
        ghost_enabled:       false,
        ghost_wins_required: 1,
        ghost_max_rounds:    999999999,

        // Martingale
        martingale_enabled:      true,
        martingale_multiplier:   11.3,
        max_martingale_steps:    3,

        // Risk
        take_profit:              100,
        stop_loss:                70,
        base_stake:               0.61,
        max_stake:                500,
        currency:                 'USD',
        contract_type:            'DIGITDIFF',
        delay_between_trades:     1500,
        cooldown_after_max_loss:  30000,

        // Asset suspension (ms to suspend losing asset)
        asset_suspension_ms:      60000,

        // Connection monitoring
        ping_interval_ms:    20000,
        pong_timeout_ms:     10000,
        data_timeout_ms:     60000,
        max_reconnect:       10,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
//  PER-ASSET STATE
// ══════════════════════════════════════════════════════════════════════════════

function createAssetState() {
    return {
        // Tick data
        tickHistory:       [],
        tickSubId:         null,
        historyLoaded:     false,

        // HMM (one detector per asset)
        hmm:               null,   // set during bot init
        regime:            null,
        signalActive:      false,
        targetDigit:       -1,
        targetRepeatRate:  0,

        // Ghost
        ghostConsecutiveWins: 0,
        ghostRoundsPlayed:    0,
        ghostConfirmed:       false,
        ghostAwaitingResult:  false,

        // Suspension
        suspended:         false,
        suspendUntil:      0,

        // Tick log throttle
        lastTickLogTime:   0,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT
// ══════════════════════════════════════════════════════════════════════════════

class RomanianGhostBotV3 {
    constructor() {
        this.config = buildConfig();

        // WebSocket
        this.ws               = null;
        this.connected        = false;
        this.wsReady          = false;
        this.reconnectAttempts = 0;
        this.isReconnecting   = false;
        this.reconnectTimer   = null;
        this.pingInterval     = null;
        this.checkDataInterval = null;
        this.pongTimeout      = null;
        this.lastPongTime     = Date.now();
        this.lastDataTime     = Date.now();
        this.requestId        = 0;

        // Account
        this.accountBalance   = 0;
        this.startingBalance  = 0;
        this.accountId        = '';

        // Assets
        this.assets = this.config.assets;
        this.assetState = {};
        for (const a of this.assets) {
            this.assetState[a] = createAssetState();
            this.assetState[a].hmm = new HMMRegimeDetector(this.config);
        }

        // Global trade lock (only one trade at a time)
        this.tradeInProgress  = false;
        this.activeTradeAsset = null;
        this.lastContractId   = null;
        this.lastBuyPrice     = 0;

        // Martingale (global)
        this.martingaleStep        = 0;
        this.totalMartingaleLoss   = 0;
        this.currentStake          = this.config.base_stake;
        this.lastTradeAsset        = null;  // asset that last lost (for martingale recovery)

        // Session stats
        this.sessionStartTime      = Date.now();
        this.totalTrades           = 0;
        this.totalWins             = 0;
        this.totalLosses           = 0;
        this.sessionProfit         = 0;
        this.currentWinStreak      = 0;
        this.currentLossStreak     = 0;
        this.maxWinStreak          = 0;
        this.maxLossStreak         = 0;
        this.maxMartingaleReached  = 0;
        this.largestWin            = 0;
        this.largestLoss           = 0;

        // Hourly Telegram stats
        this.hourlyStats = { trades:0, wins:0, losses:0, pnl:0 };

        // Cooldown
        this.cooldownTimer  = null;
        this.inCooldown     = false;
        this.endOfDay       = false;

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // Restore saved state
        this.restoreState();
    }

    restoreState() {
        const saved = StatePersistence.load();
        if (!saved) return;
        try {
            const { session, martingale, perAsset } = saved;
            Object.assign(this, session);
            this.martingaleStep      = martingale.martingaleStep;
            this.totalMartingaleLoss = martingale.totalMartingaleLoss;
            this.currentStake        = martingale.currentStake;

            for (const [asset, data] of Object.entries(perAsset)) {
                if (!this.assetState[asset]) continue;
                const as = this.assetState[asset];
                as.tickHistory         = data.tickHistory || [];
                as.ghostConsecutiveWins = data.ghostConsecutiveWins || 0;
                as.ghostRoundsPlayed    = data.ghostRoundsPlayed || 0;
                as.ghostConfirmed       = data.ghostConfirmed || false;
                as.targetDigit          = data.targetDigit !== undefined ? data.targetDigit : -1;
            }

            logPersist(`State restored | Trades:${this.totalTrades} W:${this.totalWins} L:${this.totalLosses} P/L:${formatMoney(this.sessionProfit)}`);
        } catch (e) {
            logError(`restoreState error: ${e.message}`);
        }
    }

    // ── Start ─────────────────────────────────────────────────────────────────
    start() {
        this.printBanner();
        StatePersistence.startAutoSave(this);
        this.startTelegramTimer();
        this.checkSchedule();
        this.connect();
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('══════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('  👻  ROMANIAN GHOST BOT v3.0  —  Multi-Asset Digit Differ   ')));
        console.log(bold(cyan('  HMM + Bayesian + CUSUM + State Persistence                  ')));
        console.log(bold(cyan('══════════════════════════════════════════════════════════════')));
        console.log(`  Assets            : ${bold(c.assets.join(', '))}`);
        console.log(`  Base Stake        : ${bold('$'+c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window   : ${bold(c.analysis_window)} ticks per asset`);
        console.log(`  HMM NonRep Conf   : ${bold((c.hmm_nonrep_confidence*100).toFixed(0)+'%')}`);
        console.log(`  Ghost Trading     : ${c.ghost_enabled ? green('ON') : red('OFF')}`);
        console.log(`  Martingale        : ${c.martingale_enabled ? green('ON')+` x${c.martingale_multiplier}` : red('OFF')}`);
        console.log(`  Take Profit       : ${green('$'+c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss         : ${red('$'+c.stop_loss.toFixed(2))}`);
        console.log(`  State Persistence : ${green('ON')} (auto-saves every 5s)`);
        console.log(bold(cyan('══════════════════════════════════════════════════════════════')));
        console.log('');
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connect() {
        if (this.endOfDay) return;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        this.cleanupWS();
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            logError(`WebSocket creation failed: ${e.message}`);
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.connected        = true;
            this.wsReady          = false;
            this.reconnectAttempts = 0;
            this.isReconnecting   = false;
            this.lastPongTime     = Date.now();
            this.lastDataTime     = Date.now();
            this.startMonitor();
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();
            try { this.handleMessage(JSON.parse(raw)); }
            catch (e) { logError(`Parse error: ${e.message}`); }
        });

        this.ws.on('pong', () => { this.lastPongTime = Date.now(); });

        this.ws.on('close', (code) => {
            logApi(`Connection closed (code:${code})`);
            this.handleDisconnect();
        });

        this.ws.on('error', e => logError(`WebSocket error: ${e.message}`));
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                this.send({ ping: 1 });
                this.pongTimeout = setTimeout(() => {
                    if (Date.now() - this.lastPongTime > this.config.pong_timeout_ms)
                        logApi(yellow('⚠️  No pong received — connection may be stale'));
                }, this.config.pong_timeout_ms);
            }
        }, this.config.ping_interval_ms);

        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;
            const silence = Date.now() - this.lastDataTime;
            if (silence > this.config.data_timeout_ms) {
                logError(`No data for ${Math.round(silence/1000)}s — forcing reconnect`);
                StatePersistence.save(this);
                if (this.ws) this.ws.terminate();
            }
        }, 10000);
    }

    stopMonitor() {
        clearInterval(this.pingInterval);
        clearInterval(this.checkDataInterval);
        clearTimeout(this.pongTimeout);
        this.pingInterval = this.checkDataInterval = this.pongTimeout = null;
    }

    cleanupWS() {
        this.stopMonitor();
        if (this.ws) {
            this.ws.removeAllListeners();
            try { if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this.connected = false;
        this.wsReady   = false;
    }

    handleDisconnect() {
        if (this.endOfDay) { this.cleanupWS(); return; }
        if (this.isReconnecting) return;

        this.connected = false;
        this.wsReady   = false;
        this.stopMonitor();
        StatePersistence.save(this);
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.config.max_reconnect) {
            logError('Max reconnect attempts reached. Stopping.');
            this.stop('Max reconnect attempts exceeded');
            return;
        }
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts-1), 30000);
        logApi(`Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.config.max_reconnect})`);
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); return true; }
        catch (e) { logError(`Send error: ${e.message}`); return false; }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }).catch(() => {});
    }

    // ── Message Router ────────────────────────────────────────────────────────
    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize':           this.handleAuth(msg);           break;
            case 'balance':             this.handleBalance(msg);         break;
            case 'history':             this.handleTickHistory(msg);     break;
            case 'tick':                this.handleTick(msg);            break;
            case 'buy':                 this.handleBuy(msg);             break;
            case 'transaction':         this.handleTransaction(msg);     break;
            case 'proposal_open_contract': this.handlePOC(msg);         break;
            case 'ping':                                                  break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown error';
        logError(`[${code}] on ${msg.msg_type || '?'}: ${emsg}`);
        switch (code) {
            case 'InvalidToken':
            case 'AuthorizationRequired':
                this.stop('Auth failed');
                break;
            case 'RateLimit':
                setTimeout(() => { this.tradeInProgress = false; }, 10000);
                break;
            case 'InsufficientBalance':
                this.stop('Insufficient balance');
                break;
            default:
                if (msg.msg_type === 'buy') {
                    this.tradeInProgress = false;
                    this.activeTradeAsset = null;
                }
        }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance  = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId       = auth.loginid || 'N/A';
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(
            `${green('✅ Authenticated')} | ${bold(this.accountId)} ` +
            `${isDemo ? dim('(Demo)') : red('(REAL!)')} | ` +
            `Balance: ${green('$'+this.accountBalance.toFixed(2))}`
        );
        this.wsReady = true;
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.initializeAssets();
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    // ── Asset Initialization ──────────────────────────────────────────────────
    initializeAssets() {
        logBot(`Subscribing to ${bold(this.assets.length)} assets...`);
        for (const asset of this.assets) {
            // Request history
            this.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count:  this.config.tick_history_size,
                end:    'latest',
                start:  1,
                style:  'ticks',
            });
            // Subscribe live ticks
            this.send({ ticks: asset, subscribe: 1 });
        }
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req && msg.echo_req.ticks_history;
        if (!asset || !msg.history || !msg.history.prices) return;
        const as = this.assetState[asset];
        if (!as) return;

        const digits = msg.history.prices.map(p => getLastDigit(p, asset));
        as.tickHistory    = digits.slice(-this.config.tick_history_size);
        as.historyLoaded  = true;
        logBot(`${green('✅')} ${bold(asset)}: loaded ${as.tickHistory.length} ticks`);
    }

    // ── Live Tick ──────────────────────────────────────────────────────────────
    handleTick(msg) {
        if (!msg.tick) return;
        if (msg.subscription) {
            const asset = msg.tick.symbol;
            const as = this.assetState[asset];
            if (as) as.tickSubId = msg.subscription.id;
        }

        const asset = msg.tick.symbol;
        const as    = this.assetState[asset];
        if (!as) return;

        const currentDigit = getLastDigit(msg.tick.quote, asset);
        as.tickHistory.push(currentDigit);
        if (as.tickHistory.length > this.config.tick_history_size)
            as.tickHistory = as.tickHistory.slice(-this.config.tick_history_size);

        // Throttled tick log (every 30s per asset)
        const now = Date.now();
        if (now - as.lastTickLogTime >= 30000) {
            logTick(`[${bold(asset)}] ...${as.tickHistory.slice(-5).join(' ')} [${bold(cyan(currentDigit))}]  ${msg.tick.quote}`);
            as.lastTickLogTime = now;
        }

        // Skip if suspended or trade in progress for another asset
        if (this.isSuspended(asset)) return;
        if (!as.historyLoaded || as.tickHistory.length < this.config.min_ticks_for_hmm) return;
        if (this.endOfDay || this.inCooldown) return;

        // If a trade is active on THIS asset, just update regime but don't re-trigger
        if (this.tradeInProgress && this.activeTradeAsset === asset) return;
        // If a trade is active on ANOTHER asset, skip analysis for this asset
        if (this.tradeInProgress && this.activeTradeAsset !== asset) return;

        // Update regime
        as.regime = as.hmm.analyze(as.tickHistory, currentDigit);
        this.applyRegimeSignal(asset, currentDigit);

        if (as.signalActive) {
            this.processSignal(asset, currentDigit);
        }
    }

    isSuspended(asset) {
        const as = this.assetState[asset];
        if (!as.suspended) return false;
        if (Date.now() >= as.suspendUntil) {
            as.suspended = false;
            logBot(`${green('✅ Reactivated:')} ${bold(asset)}`);
            return false;
        }
        return true;
    }

    suspendAsset(asset) {
        const as = this.assetState[asset];
        as.suspended    = true;
        as.suspendUntil = Date.now() + this.config.asset_suspension_ms;
        logRisk(`🚫 Suspended ${bold(asset)} for ${this.config.asset_suspension_ms/1000}s`);
    }

    applyRegimeSignal(asset, currentDigit) {
        const as = this.assetState[asset];
        as.targetDigit = currentDigit;
        if (!as.regime || !as.regime.valid) { as.signalActive = false; return; }
        as.targetRepeatRate = as.regime.rawRepeatProb[currentDigit];
        as.signalActive     = as.regime.signalActive;

        if (as.signalActive) {
            const r = as.regime;
            logAnalysis(green(
                `✅ SIGNAL [${bold(asset)}] digit:${currentDigit} ` +
                `HMM:${r.hmmStateName} P(NR):${(r.posteriorNonRep*100).toFixed(1)}% ` +
                `persist:${r.hmmPersistence} score:${r.safetyScore}/100`
            ));
        }
    }

    processSignal(asset, currentDigit) {
        if (!this.assetState[asset].signalActive) return;
        if (this.tradeInProgress) return;

        if (this.config.ghost_enabled && !this.assetState[asset].ghostConfirmed) {
            this.runGhostCheck(asset, currentDigit);
        } else {
            this.executeTradeFlow(asset);
        }
    }

    // ── Ghost ─────────────────────────────────────────────────────────────────
    runGhostCheck(asset, currentDigit) {
        const as = this.assetState[asset];
        if (!as.signalActive) { this.resetGhost(asset); return; }

        as.ghostRoundsPlayed++;

        if (as.ghostAwaitingResult) {
            as.ghostAwaitingResult = false;
            if (currentDigit !== as.targetDigit) {
                as.ghostConsecutiveWins++;
                logGhost(`👻 [${asset}] ${green(`Ghost WIN ${as.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
            } else {
                as.ghostConsecutiveWins = 0;
                logGhost(`👻 [${asset}] ${red('Ghost LOSS — digit repeated — reset')}`);
            }
        } else {
            if (currentDigit === as.targetDigit) {
                const wif = as.ghostConsecutiveWins + 1;
                if (wif >= this.config.ghost_wins_required) {
                    as.ghostConsecutiveWins = wif;
                    as.ghostConfirmed = true;
                    logGhost(green(`👻 [${asset}] Ghost confirmed! Placing LIVE trade.`));
                    this.executeTradeFlow(asset);
                } else {
                    as.ghostAwaitingResult = true;
                    logGhost(`👻 [${asset}] Digit appeared, wins:${as.ghostConsecutiveWins}/${this.config.ghost_wins_required}`);
                }
            }
        }

        if (!as.ghostConfirmed && as.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`⚠️  [${asset}] Max ghost rounds — resetting`));
            this.resetGhost(asset);
        }
    }

    resetGhost(asset) {
        const as = this.assetState[asset];
        as.ghostConsecutiveWins = 0;
        as.ghostRoundsPlayed    = 0;
        as.ghostConfirmed       = false;
        as.ghostAwaitingResult  = false;
        as.targetDigit          = -1;
        as.signalActive         = false;
    }

    // ── Trade Execution ───────────────────────────────────────────────────────
    executeTradeFlow(asset) {
        if (this.tradeInProgress) return;
        if (this.inCooldown || this.endOfDay) return;

        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown();  return; }
            return;
        }

        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake || this.currentStake > this.accountBalance) {
            this.stop('Stake exceeds limits or balance');
            return;
        }

        this.placeTrade(asset);
    }

    placeTrade(asset) {
        const as = this.assetState[asset];
        this.tradeInProgress  = true;
        this.activeTradeAsset = asset;
        this.lastTradeAsset   = asset;

        const r = as.regime;
        const score  = r && r.valid ? r.safetyScore : 0;
        const pnrPct = r && r.valid ? (r.posteriorNonRep*100).toFixed(1)+'%' : '?';

        logTrade(
            `🎯 [${bold(cyan(asset))}] DIFFER from ${bold(as.targetDigit)} | ` +
            `Stake:${bold('$'+this.currentStake.toFixed(2))} Mart:${this.martingaleStep}/${this.config.max_martingale_steps} | ` +
            `Rate:${as.targetRepeatRate.toFixed(1)}% Score:${score}/100 P(NR):${pnrPct}`
        );

        this.sendTelegram(`
          🎯 <b>GHOST TRADE</b>

          📊 Asset: <b>${asset}</b>
          🔢 Target Digit: ${as.targetDigit}
          📜 Last 10 ticks: ${as.tickHistory.slice(-10).join(', ')}
          💰 Stake: $${this.currentStake.toFixed(2)} | Mart step: ${this.martingaleStep}
          📈 Repeat Rate: ${as.targetRepeatRate.toFixed(1)}%
          🔬 Score: ${score}/100 | P(NR): ${pnrPct}
          📊 Session: ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L
          ⏰ ${new Date().toLocaleTimeString()}`.trim());

        const ok = this.send({
            buy: 1,
            price: this.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol:        asset,
                duration:      1,
                duration_unit: 't',
                basis:         'stake',
                amount:        this.currentStake,
                barrier:       String(as.targetDigit),
                currency:      this.config.currency,
            },
        });

        if (!ok) {
            logError('Failed to send buy — releasing trade lock');
            this.tradeInProgress  = false;
            this.activeTradeAsset = null;
        }
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice   = parseFloat(msg.buy.buy_price);
        logTrade(dim(`Contract ${this.lastContractId} | Cost:$${this.lastBuyPrice.toFixed(2)} | Payout:$${parseFloat(msg.buy.payout).toFixed(2)}`));
        // Subscribe to contract for result
        this.send({ proposal_open_contract: 1, contract_id: this.lastContractId, subscribe: 1 });
    }

    handlePOC(msg) {
        if (!msg.proposal_open_contract) return;
        if (msg.proposal_open_contract.is_sold) this.handleTradeResult(msg.proposal_open_contract);
    }

    handleTransaction(msg) {
        // Backup result handler via transaction stream
        if (!msg.transaction || msg.transaction.action !== 'sell') return;
        if (!this.tradeInProgress) return;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.processResult(profit);
    }

    handleTradeResult(contract) {
        if (!this.tradeInProgress) return;
        const profit = parseFloat(contract.profit);
        this.processResult(profit);
    }

    processResult(profit) {
        if (!this.tradeInProgress) return; // guard double-fire
        const asset = this.activeTradeAsset;
        this.totalTrades++;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (profit > 0) {
            this.onWin(asset, profit);
        } else {
            this.onLoss(asset, Math.abs(profit));
        }

        this.tradeInProgress  = false;
        this.activeTradeAsset = null;
        this.decideNextAction();
    }

    onWin(asset, profit) {
        const as = this.assetState[asset];
        this.totalWins++;
        this.hourlyStats.wins++;
        this.sessionProfit     += profit;
        this.currentWinStreak++;
        this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;

        as.hmm.resetCUSUM(as.targetDigit);
        this.resetMartingale();
        this.resetGhost(asset);

        const plStr = formatMoney(this.sessionProfit);
        logResult(`${green('✅ WIN!')} [${bold(asset)}] Profit:${green('+$'+profit.toFixed(2))} | P/L:${this.sessionProfit>=0?green(plStr):red(plStr)} | Bal:${green('$'+this.accountBalance.toFixed(2))}`);
        logResult(dim(`  Target:${as.targetDigit} | History tail: [${as.tickHistory.slice(-5).join(',')}]`));

        this.sendTelegram(`
          ✅ <b>WIN!</b> — ${asset}

          📊 Target Digit: ${as.targetDigit}
          📜 Last 10: ${as.tickHistory.slice(-10).join(', ')}
          💰 Profit: +$${profit.toFixed(2)}
          💵 P&L: ${formatMoney(this.sessionProfit)}
          📊 Balance: $${this.accountBalance.toFixed(2)}
          📈 ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentWinStreak}W`.trim());
    }

    onLoss(asset, lostAmount) {
        const as = this.assetState[asset];
        this.totalLosses++;
        this.hourlyStats.losses++;
        this.sessionProfit     -= lostAmount;
        this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++;
        this.currentWinStreak  = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

        // Reset ghost wins for losing asset
        as.ghostConsecutiveWins = 0;
        as.ghostConfirmed       = false;
        as.ghostRoundsPlayed    = 0;
        as.ghostAwaitingResult  = false;

        // Suspend losing asset briefly
        this.suspendAsset(asset);

        const plStr = formatMoney(this.sessionProfit);
        logResult(`${red('❌ LOSS!')} [${bold(asset)}] Lost:${red('-$'+lostAmount.toFixed(2))} | P/L:${this.sessionProfit>=0?green(plStr):red(plStr)} | Mart:${this.martingaleStep}/${this.config.max_martingale_steps}`);

        this.sendTelegram(`
          ❌ <b>LOSS!</b> — ${asset}

          📊 Target Digit: ${as.targetDigit}
          📜 Last 10: ${as.tickHistory.slice(-10).join(', ')}
          💸 Lost: -$${lostAmount.toFixed(2)}
          💵 P&L: ${formatMoney(this.sessionProfit)}
          📊 Balance: $${this.accountBalance.toFixed(2)}
          📈 ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentLossStreak}L | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}`.trim());
    }

    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); }
            return;
        }
        // If in martingale recovery, the next tick on any non-suspended asset will trigger
    }

    // ── Risk / Stake ──────────────────────────────────────────────────────────
    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0)
            return this.config.base_stake;
        const raw  = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
        const calc = Math.round(raw * 100) / 100;
        return Math.min(calc, this.config.max_stake);
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT REACHED!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🎯 Take profit: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS HIT!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🛑 Stop loss: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const nextStake = this.calculateStake();
        if (nextStake > this.accountBalance)
            return { canTrade: false, reason: 'Next stake > balance', action: 'STOP' };
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: 'Max Martingale steps', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    resetMartingale() {
        this.martingaleStep      = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake        = this.config.base_stake;
    }

    startCooldown() {
        if (this.inCooldown) return;
        this.inCooldown = true;
        this.resetMartingale();
        for (const a of this.assets) this.resetGhost(a);
        const sec = this.config.cooldown_after_max_loss / 1000;
        logBot(`⏸️  Cooldown for ${sec}s...`);
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => {
            if (this.inCooldown) {
                this.inCooldown = false;
                logBot(green('▶️  Cooldown ended. Resuming...'));
            }
        }, this.config.cooldown_after_max_loss);
    }

    // ── Schedule / Telegram ───────────────────────────────────────────────────
    checkSchedule() {
        setInterval(() => {
            const now  = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const day  = gmt1.getUTCDay();
            const h    = gmt1.getUTCHours();
            const m    = gmt1.getUTCMinutes();

            const isWeekend = day === 0 ||
                (day === 6 && h >= 23) ||
                (day === 1 && h < 8);

            if (isWeekend && !this.endOfDay) {
                logBot(yellow('📅 Weekend trading pause'));
                this.sendTelegram('📅 <b>Weekend pause</b> — bot suspended until Monday 8am GMT+1');
                this.endOfDay = true;
                StatePersistence.save(this);
                return;
            }

            if (this.endOfDay && !isWeekend && h >= 8) {
                logBot(green('📅 Weekday 8am — resuming'));
                this.endOfDay = false;
                this.connect();
            }
        }, 30000);
    }

    startTelegramTimer() {
        const now      = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours()+1, 0, 0, 0);
        const wait = nextHour - now;

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 3600000);
        }, wait);

        logBot(`📱 Telegram hourly summary in ${Math.ceil(wait/60000)}m`);
    }

    async sendHourlySummary() {
        const s = this.hourlyStats;
        const wr = s.trades > 0 ? ((s.wins/s.trades)*100).toFixed(1) : '0.0';
        await this.sendTelegram(`
⏰ <b>Hourly Summary — Ghost Bot v3</b>

📊 Last Hour
├ Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}
├ Win Rate: ${wr}%
└ P&L: ${(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)}

📈 Session Totals
├ Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}
├ P&L: ${formatMoney(this.sessionProfit)}
└ Balance: $${this.accountBalance.toFixed(2)}

⏰ ${new Date().toLocaleString()}`.trim());

        this.hourlyStats = { trades:0, wins:0, losses:0, pnl:0 };
    }

    // ── Shutdown ──────────────────────────────────────────────────────────────
    stop(reason = 'User stopped') {
        logBot(`🛑 ${bold('Stopping:')} ${reason}`);
        this.endOfDay = true;
        clearTimeout(this.cooldownTimer);
        clearTimeout(this.reconnectTimer);
        StatePersistence.save(this);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) {}
            setTimeout(() => { try { this.ws.close(); } catch (_) {} }, 500);
        }

        this.sendTelegram(`🛑 <b>SESSION STOPPED</b>\n\nReason: ${reason}\nFinal P&L: $${this.sessionProfit.toFixed(2)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1500);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr  = this.totalTrades > 0 ? ((this.totalWins/this.totalTrades)*100).toFixed(1) : '0.0';
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('══════════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                     ')));
        logStats(bold(cyan('══════════════════════════════════════════════════')));
        logStats(`  Duration       : ${bold(formatDuration(dur))}`);
        logStats(`  Assets         : ${bold(this.assets.join(', '))}`);
        logStats(`  Total Trades   : ${bold(this.totalTrades)}`);
        logStats(`  Wins           : ${green(this.totalWins)}`);
        logStats(`  Losses         : ${red(this.totalLosses)}`);
        logStats(`  Win Rate       : ${bold(wr+'%')}`);
        logStats(`  Session P/L    : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Start Balance  : $${this.startingBalance.toFixed(2)}`);
        logStats(`  End Balance    : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Largest Win    : ${green('+$'+this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss   : ${red('-$'+this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak: ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale : Step ${this.maxMartingaleReached}`);
        logStats(bold(cyan('══════════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
    const bot = new RomanianGhostBotV3();

    process.on('SIGINT',  () => { console.log(''); bot.stop('SIGINT (Ctrl+C)'); });
    process.on('SIGTERM', () => { bot.stop('SIGTERM'); });
    process.on('uncaughtException', e => {
        logError(`Uncaught: ${e.message}\n${e.stack}`);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', reason => {
        logError(`Unhandled rejection: ${reason}`);
    });

    bot.start();
})();
