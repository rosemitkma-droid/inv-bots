#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v4.0 Multi-Asset Precision Regime Detection
//  Deriv Digit Differ — Multi-Method Ensemble Regime Engine
//
//  UPGRADED v4.0:
//    • Multi-Asset Support (R_10, R_25, R_50, R_75, R_100, RDBULL, RDBEAR)
//    • Independent AdvancedRegimeDetector per asset
//    • StatePersistence with auto-save (from x4DifferBot pattern)
//    • Per-asset ghost trading, CUSUM, martingale tracking
//    • Robust reconnection with exponential backoff
//    • Heartbeat/Ping monitor (no data timeout = force reconnect)
//    • Message queue for sends during reconnect
//    • Hourly Telegram summaries
//    • Weekend auto-disconnect / weekday auto-reconnect
//
//  REGIME ENGINE (per asset, unchanged from v3.0):
//    1. BOCPD (Beta-Bernoulli) — run-length posterior
//    2. Binary HMM (2-state)   — Baum-Welch, Viterbi
//    3. Multi-Scale EWMA Stack — 4 horizons
//    4. Lag ACF Analysis       — repeat clustering detector
//    5. Structural Break Test  — LRT on window halves
//    6. Two-Sided CUSUM        — up/down regime shift
//    7. Adaptive Ensemble Weights
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ── Credentials ────────────────────────────────────────────────────────────────
const API_TOKEN        = '0P94g4WdSrSrzir';
const TELEGRAM_TOKEN   = '8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8';
const CHAT_ID          = '752497117';
const APP_ID           = '1089';
const WS_ENDPOINT      = 'wss://ws.derivws.com/websockets/v3';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
    reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
    cyan:'\x1b[36m', blue:'\x1b[34m', green:'\x1b[32m',
    red:'\x1b[31m', yellow:'\x1b[33m', magenta:'\x1b[35m',
    orange:'\x1b[38;5;208m', white:'\x1b[37m',
};
const col  = (t,...c) => c.join('') + t + C.reset;
const bold = t => col(t, C.bold);
const dim  = t => col(t, C.dim);
const cyan = t => col(t, C.cyan);
const blue = t => col(t, C.blue);
const green  = t => col(t, C.green);
const red    = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta= t => col(t, C.magenta);

// ── Logger ────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT:'cyan', API:'blue', TICK:'dim', ANALYSIS:'yellow',
    GHOST:'magenta', TRADE:'bold', RESULT:'bold', RISK:'red',
    STATS:'cyan', ERROR:'red+bold', HMM:'orange', BOCPD:'green',
    REGIME:'magenta', PERSIST:'blue',
};
const loggers = {};
['BOT','API','TICK','ANALYSIS','GHOST','TRADE','RESULT','RISK','STATS','ERROR','HMM','BOCPD','REGIME','PERSIST'].forEach(p => {
    const fn = {
        cyan, blue, dim, yellow, magenta, bold, red, green,
        orange: t => col(t, C.orange),
        'red+bold': t => col(t, C.bold, C.red),
    }[PREFIX_COLOURS[p]] || (t => t);
    loggers[p] = m => {
        const ts = dim(`[${new Date().toTimeString().slice(0,8)}]`);
        console.log(`${ts} ${fn(`[${p}]`)} ${m}`);
    };
});
const { BOT:logBot, API:logApi, TICK:logTick, ANALYSIS:logAnalysis,
    GHOST:logGhost, TRADE:logTrade, RESULT:logResult, RISK:logRisk,
    STATS:logStats, ERROR:logError, HMM:logHMM, BOCPD:logBocpd,
    REGIME:logRegime, PERSIST:logPersist } = loggers;

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
    api_token:    API_TOKEN,
    app_id:       APP_ID,
    endpoint:     WS_ENDPOINT,

    // Assets to trade
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'],

    base_stake:    0.61,
    currency:      'USD',
    contract_type: 'DIGITDIFF',

    // History
    tick_history_size:        5000,
    analysis_window:          3000,
    min_ticks_for_analysis:   100,

    // Regime detection
    repeat_threshold:          8,
    hmm_nonrep_confidence:     0.85,
    bocpd_nonrep_confidence:   0.82,
    min_regime_persistence:    8,
    acf_lag1_threshold:        0.15,
    ewma_trend_threshold:      2.0,
    cusum_up_threshold:        3.5,
    cusum_down_threshold:      -4.0,
    cusum_slack:               0.15,
    structural_break_threshold:0.15,

    // BOCPD
    bocpd_hazard:              1 / 150,
    bocpd_prior_alpha:         1,
    bocpd_prior_beta:          9,
    bocpd_min_run_for_signal:  15,

    // HMM
    hmm_refit_every:           50,
    hmm_min_discrimination:    0.10,

    // Ensemble
    repeat_confidence:         70,

    // Ghost
    ghost_enabled:             false,
    ghost_wins_required:       1,
    ghost_max_rounds:          2000000000,

    // Martingale
    martingale_enabled:        true,
    martingale_multiplier:     11.3,
    max_martingale_steps:      3,

    // Risk
    take_profit:               100,
    stop_loss:                 70,
    max_stake:                 500,
    delay_between_trades:      1500,
    cooldown_after_max_loss:   30000,

    // Connection
    ping_interval_ms:          20000,
    pong_timeout_ms:           10000,
    data_timeout_ms:           60000,
    max_reconnect_attempts:    50,
    reconnect_base_delay:      5000,

    // Persistence
    state_file:                path.join(__dirname, 'ghost-bot-v400001-state.json'),
    state_save_interval:       5000,
    state_max_age_minutes:     30,
};

// ════════════════════════════════════════════════════════════════════════════
//  MATH UTILITIES
// ════════════════════════════════════════════════════════════════════════════
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}
function lgamma(z) {
    const g = 7;
    const c = [0.99999999999980993,676.5203681218851,-1259.1392167224028,
        771.32342877765313,-176.61502916214059,12.507343278686905,
        -0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function continuedFraction(x, a, b) {
    const MAX = 200, EPS = 3e-7;
    let f = 1, Cv = 1, D = 1 - (a + b) * x / (a + 1);
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D; f = D;
    for (let m = 1; m <= MAX; m++) {
        let aa = m * (b - m) * x / ((a + 2*m - 1) * (a + 2*m));
        D = 1 + aa * D; Cv = 1 + aa / Cv;
        if (Math.abs(D) < 1e-30) D = 1e-30; if (Math.abs(Cv) < 1e-30) Cv = 1e-30;
        D = 1/D; let delta = Cv*D; f *= delta;
        aa = -(a+m)*(a+b+m)*x/((a+2*m)*(a+2*m+1));
        D = 1 + aa*D; Cv = 1 + aa/Cv;
        if (Math.abs(D) < 1e-30) D = 1e-30; if (Math.abs(Cv) < 1e-30) Cv = 1e-30;
        D = 1/D; delta = Cv*D; f *= delta;
        if (Math.abs(delta - 1) < EPS) break;
    }
    return f;
}
function betaIncomplete(x, a, b) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0; if (x === 1) return 1;
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x)*a + Math.log(1-x)*b - lbeta) / a;
    return front * continuedFraction(x, a, b);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac = parts.length > 1 ? parts[1] : '';
    if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}
function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms/1000), h = Math.floor(t/3600),
          m = Math.floor((t%3600)/60), s = t%60;
    if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
}

// ════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════
class StatePersistence {
    static save(bot) {
        try {
            const state = {
                savedAt: Date.now(),
                sessionProfit:     bot.sessionProfit,
                totalTrades:       bot.totalTrades,
                totalWins:         bot.totalWins,
                totalLosses:       bot.totalLosses,
                startingBalance:   bot.startingBalance,
                maxWinStreak:      bot.maxWinStreak,
                maxLossStreak:     bot.maxLossStreak,
                maxMartingaleReached: bot.maxMartingaleReached,
                largestWin:        bot.largestWin,
                largestLoss:       bot.largestLoss,
                // Per-asset state
                assetStates: {},
            };

            for (const asset of bot.config.assets) {
                const as = bot.assetStates[asset];
                if (!as) continue;
                state.assetStates[asset] = {
                    martingaleStep:   as.martingaleStep,
                    currentStake:     as.currentStake,
                    // Keep last 200 ticks for warmup
                    tickHistory:      as.tickHistory.slice(-200),
                };
            }

            fs.writeFileSync(bot.config.state_file, JSON.stringify(state, null, 2));
        } catch (e) {
            logPersist(red(`Save failed: ${e.message}`));
        }
    }

    static load(bot) {
        try {
            if (!fs.existsSync(bot.config.state_file)) {
                logPersist('No previous state, starting fresh');
                return false;
            }
            const raw  = JSON.parse(fs.readFileSync(bot.config.state_file, 'utf8'));
            const age  = (Date.now() - raw.savedAt) / 60000;
            if (age > bot.config.state_max_age_minutes) {
                logPersist(yellow(`State ${age.toFixed(1)}min old — too stale, starting fresh`));
                fs.unlinkSync(bot.config.state_file);
                return false;
            }
            logPersist(green(`Restoring state from ${age.toFixed(1)}min ago`));

            bot.sessionProfit         = raw.sessionProfit  || 0;
            bot.totalTrades           = raw.totalTrades    || 0;
            bot.totalWins             = raw.totalWins      || 0;
            bot.totalLosses           = raw.totalLosses    || 0;
            bot.startingBalance       = raw.startingBalance || 0;
            bot.maxWinStreak          = raw.maxWinStreak   || 0;
            bot.maxLossStreak         = raw.maxLossStreak  || 0;
            bot.maxMartingaleReached  = raw.maxMartingaleReached || 0;
            bot.largestWin            = raw.largestWin     || 0;
            bot.largestLoss           = raw.largestLoss    || 0;

            if (raw.assetStates) {
                for (const asset of bot.config.assets) {
                    const saved = raw.assetStates[asset];
                    if (!saved || !bot.assetStates[asset]) continue;
                    bot.assetStates[asset].martingaleStep = saved.martingaleStep || 0;
                    bot.assetStates[asset].currentStake   = saved.currentStake  || bot.config.base_stake;
                    if (saved.tickHistory && saved.tickHistory.length > 0) {
                        bot.assetStates[asset].tickHistory = saved.tickHistory;
                    }
                }
            }

            logPersist(`Trades:${raw.totalTrades} W/L:${raw.totalWins}/${raw.totalLosses} P&L:${formatMoney(raw.sessionProfit)}`);
            return true;
        } catch (e) {
            logPersist(red(`Load failed: ${e.message}`));
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => StatePersistence.save(bot), bot.config.state_save_interval);
        logPersist(`Auto-save every ${bot.config.state_save_interval/1000}s`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BOCPD
// ════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard   = config.bocpd_hazard;
        this.alpha0   = config.bocpd_prior_alpha;
        this.beta0    = config.bocpd_prior_beta;
        this.minRun   = config.bocpd_min_run_for_signal;
        this.threshold= config.bocpd_nonrep_confidence;
        this.logR     = [0];
        this.alphas   = [this.alpha0];
        this.betas    = [this.beta0];
        this.t        = 0;
        this.pNonRep  = 0.5;
        this.expectedRunLength = 0;
    }
    update(obs) {
        this.t++;
        const H = this.hazard, lenR = this.logR.length;
        const logPredictive = new Array(lenR);
        for (let r = 0; r < lenR; r++) {
            const theta = this.alphas[r] / (this.alphas[r] + this.betas[r]);
            const p = obs === 1 ? theta : (1 - theta);
            logPredictive[r] = Math.log(Math.max(p, 1e-300));
        }
        const logGrowthMass = logPredictive.map((lp,r) => lp + Math.log(1-H) + this.logR[r]);
        const logChangepointMass = logSumExp(logPredictive.map((lp,r) => lp + Math.log(H) + this.logR[r]));
        const newLogR = new Array(lenR + 1);
        const newAlphas = new Array(lenR + 1);
        const newBetas  = new Array(lenR + 1);
        newLogR[0]   = logChangepointMass;
        newAlphas[0] = this.alpha0 + obs;
        newBetas[0]  = this.beta0 + (1 - obs);
        for (let r = 0; r < lenR; r++) {
            newLogR[r+1]   = logGrowthMass[r];
            newAlphas[r+1] = this.alphas[r] + obs;
            newBetas[r+1]  = this.betas[r]  + (1 - obs);
        }
        const logZ = logSumExp(newLogR);
        this.logR   = newLogR.map(v => v - logZ);
        this.alphas = newAlphas;
        this.betas  = newBetas;
        if (this.logR.length > 800) {
            const thr  = Math.max(...this.logR) - 15;
            let keep   = this.logR.map((_,i) => i).filter(i => this.logR[i] > thr);
            if (!keep.includes(0)) keep.unshift(0);
            this.logR   = keep.map(i => this.logR[i]);
            this.alphas = keep.map(i => this.alphas[i]);
            this.betas  = keep.map(i => this.betas[i]);
            const logZ2 = logSumExp(this.logR);
            this.logR   = this.logR.map(v => v - logZ2);
        }
        const probs = this.logR.map(Math.exp);
        this.expectedRunLength = probs.reduce((s,p,r) => s + p*r, 0);
        const modeIdx   = this.logR.indexOf(Math.max(...this.logR));
        const thetaMode = this.alphas[modeIdx] / (this.alphas[modeIdx] + this.betas[modeIdx]);
        const pLongRun  = probs.slice(this.minRun).reduce((s,p) => s + p, 0);
        const pLowTheta = betaIncomplete(0.15, this.alphas[modeIdx], this.betas[modeIdx]);
        this.pNonRep    = clamp(pLongRun * 0.5 + pLowTheta * 0.5, 0, 1);
        return {
            pNonRep: this.pNonRep, expectedRL: this.expectedRunLength,
            modeRL: modeIdx, thetaEstimate: thetaMode,
            pLongRun, pLowTheta,
            pChangepoint: Math.exp(this.logR[0]),
        };
    }
    isNonRepRegime() {
        return this.pNonRep >= this.threshold && this.expectedRunLength >= this.minRun;
    }
    reset() {
        this.logR = [0]; this.alphas = [this.alpha0]; this.betas = [this.beta0];
        this.t = 0; this.pNonRep = 0.5; this.expectedRunLength = 0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Binary HMM
// ════════════════════════════════════════════════════════════════════════════
class BinaryHMM {
    constructor(config) {
        this.cfg = config;
        this.MIN_DISCRIM = config.hmm_min_discrimination || 0.10;
        this.pi  = [0.65, 0.35];
        this.A   = [[0.93,0.07],[0.22,0.78]];
        this.B   = [[0.91,0.09],[0.55,0.45]];
        this.logAlpha = [Math.log(0.65), Math.log(0.35)];
        this.fitted = false;
        this.lastFitDiscrim = 0;
    }
    buildObs(digitSeq) {
        const obs = new Array(digitSeq.length - 1);
        for (let t = 1; t < digitSeq.length; t++)
            obs[t-1] = digitSeq[t] === digitSeq[t-1] ? 1 : 0;
        return obs;
    }
    baumWelch(obs, maxIter = 30, tol = 1e-6) {
        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };
        let pi = [...this.pi];
        let A  = this.A.map(r => [...r]);
        let B  = this.B.map(r => [...r]);
        let prevLogL = -Infinity;
        for (let iter = 0; iter < maxIter; iter++) {
            const logAlpha = Array.from({length:T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logAlpha[0][s] = Math.log(pi[s]+1e-300) + Math.log(B[s][obs[0]]+1e-300);
            for (let t = 1; t < T; t++) for (let s = 0; s < N; s++) {
                const inc = [0,1].map(p => logAlpha[t-1][p] + Math.log(A[p][s]+1e-300));
                logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]]+1e-300);
            }
            const logL = logSumExp(logAlpha[T-1]);
            const logBeta = Array.from({length:T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T-1][s] = 0;
            for (let t = T-2; t >= 0; t--) for (let s = 0; s < N; s++) {
                const vals = [0,1].map(nx => Math.log(A[s][nx]+1e-300)+Math.log(B[nx][obs[t+1]]+1e-300)+logBeta[t+1][nx]);
                logBeta[t][s] = logSumExp(vals);
            }
            const logGamma = Array.from({length:T}, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const d = logSumExp([0,1].map(s => logAlpha[t][s]+logBeta[t][s]));
                for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s]+logBeta[t][s]-d;
            }
            const logXi = Array.from({length:T-1}, () => Array.from({length:N}, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T-1; t++) {
                const d = logSumExp([0,1].map(s => logAlpha[t][s]+logBeta[t][s]));
                for (let s = 0; s < N; s++) for (let nx = 0; nx < N; nx++)
                    logXi[t][s][nx] = logAlpha[t][s]+Math.log(A[s][nx]+1e-300)+Math.log(B[nx][obs[t+1]]+1e-300)+logBeta[t+1][nx]-d;
            }
            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi.reduce((a,b) => a+b, 0);
            pi = pi.map(v => v/piSum);
            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0,T-1).map(g => g[s]));
                for (let nx = 0; nx < N; nx++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][nx]));
                    A[s][nx] = Math.exp(numer - denom);
                }
                const rs = A[s].reduce((a,b) => a+b, 0);
                A[s] = A[s].map(v => v/rs);
            }
            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < O; o++) {
                    const relevant = logGamma.filter((_,t) => obs[t] === o).map(g => g[s]);
                    B[s][o] = relevant.length > 0 ? Math.exp(logSumExp(relevant)-denom) : 1e-10;
                }
                const bsum = B[s].reduce((a,b) => a+b, 0);
                B[s] = B[s].map(v => v/bsum);
            }
            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }
        if (B[0][1] > B[1][1]) {
            [pi[0],pi[1]] = [pi[1],pi[0]];
            [A[0],A[1]]   = [A[1],A[0]];
            A[0] = [A[0][1],A[0][0]]; A[1] = [A[1][1],A[1][0]];
            [B[0],B[1]]   = [B[1],B[0]];
        }
        const discrimination = B[1][1] - B[0][1];
        if (discrimination < this.MIN_DISCRIM)
            return { accepted:false, discrimination, repeatNR:B[0][1], repeatREP:B[1][1],
                reason:`discrimination ${(discrimination*100).toFixed(1)}% < ${(this.MIN_DISCRIM*100).toFixed(0)}% threshold` };
        this.pi = pi; this.A = A; this.B = B;
        this.fitted = true; this.lastFitDiscrim = discrimination;
        return { accepted:true, discrimination, repeatNR:B[0][1], repeatREP:B[1][1] };
    }
    viterbi(obs) {
        const T = obs.length, N = 2;
        if (T === 0) return null;
        const logDelta = Array.from({length:T}, () => new Array(N).fill(-Infinity));
        const psi      = Array.from({length:T}, () => new Array(N).fill(0));
        for (let s = 0; s < N; s++) logDelta[0][s] = Math.log(this.pi[s]+1e-300)+Math.log(this.B[s][obs[0]]+1e-300);
        for (let t = 1; t < T; t++) for (let s = 0; s < N; s++) {
            let best = -Infinity, bp = 0;
            for (let p = 0; p < N; p++) {
                const v = logDelta[t-1][p]+Math.log(this.A[p][s]+1e-300);
                if (v > best) { best = v; bp = p; }
            }
            logDelta[t][s] = best + Math.log(this.B[s][obs[t]]+1e-300);
            psi[t][s] = bp;
        }
        const seq = new Array(T);
        seq[T-1] = logDelta[T-1][0] >= logDelta[T-1][1] ? 0 : 1;
        for (let t = T-2; t >= 0; t--) seq[t] = psi[t+1][seq[t+1]];
        const cur = seq[T-1];
        let persistence = 1;
        for (let t = T-2; t >= 0; t--) { if (seq[t] === cur) persistence++; else break; }
        let transitions = 0;
        for (let t = 1; t < T; t++) if (seq[t] !== seq[t-1]) transitions++;
        const seg = Math.max(1, Math.floor(T/5));
        const segFracs = [];
        for (let i = 0; i < 5 && i*seg < T; i++) {
            const sl = seq.slice(i*seg, Math.min((i+1)*seg, T));
            segFracs.push(sl.filter(s => s===0).length / sl.length);
        }
        const stability = segFracs.reduce((a,b) => a+b, 0) / segFracs.length;
        return { stateSeq:seq, currentState:cur, persistence, transitions, stability };
    }
    repeatEmission(state) { return this.B[state][1]; }
}

// ════════════════════════════════════════════════════════════════════════════
//  EWMA Stack
// ════════════════════════════════════════════════════════════════════════════
class EWMAStack {
    constructor() {
        this.lambdas = [0.40,0.18,0.07,0.025];
        this.values  = [null,null,null,null];
        this.n = 0;
    }
    update(repeatObs) {
        const v = repeatObs * 100; this.n++;
        for (let i = 0; i < 4; i++) {
            if (this.values[i] === null) this.values[i] = v;
            else this.values[i] = this.lambdas[i]*v + (1-this.lambdas[i])*this.values[i];
        }
    }
    get(idx) { return this.values[idx] ?? 50; }
    trend()   { return this.get(1) - this.get(3); }
    allBelowThreshold(thr) { return this.values.every(v => v === null || v < thr); }
}

// ════════════════════════════════════════════════════════════════════════════
//  ACF + Structural Break
// ════════════════════════════════════════════════════════════════════════════
function computeACF(seq, maxLag = 5) {
    const n = seq.length;
    if (n < maxLag + 2) return new Array(maxLag).fill(0);
    const mean = seq.reduce((s,v) => s+v,0)/n;
    const variance = seq.reduce((s,v) => s+(v-mean)**2,0)/n;
    if (variance < 1e-10) return new Array(maxLag).fill(0);
    const acf = [];
    for (let lag = 1; lag <= maxLag; lag++) {
        let cov = 0;
        for (let t = 0; t < n-lag; t++) cov += (seq[t]-mean)*(seq[t+lag]-mean);
        acf.push(cov / ((n-lag)*variance));
    }
    return acf;
}
function structuralBreakTest(repeatSeq) {
    const n = repeatSeq.length;
    if (n < 20) return { lrtStat:0, pBreak:0, rateOld:0.1, rateNew:0.1 };
    const half = Math.floor(n/2);
    const k1 = repeatSeq.slice(0,half).reduce((s,v) => s+v, 0);
    const k2 = repeatSeq.slice(half).reduce((s,v) => s+v, 0);
    const n1 = half, n2 = n - half;
    const p1 = k1/n1, p2 = k2/n2;
    const pPool = (k1+k2)/(n1+n2);
    const logLik = (k,n,p) => (p<=0||p>=1) ? 0 : k*Math.log(p)+(n-k)*Math.log(1-p);
    const lrtStat = 2*(logLik(k1,n1,p1)+logLik(k2,n2,p2)-logLik(k1+k2,n1+n2,pPool));
    const chi2cdf = lrtStat <= 0 ? 0 : Math.min(0.9999, 1-Math.exp(-0.5*Math.max(0,lrtStat)*0.5));
    const pBreak = p2 > p1 ? chi2cdf : 0;
    return { lrtStat:Math.max(0,lrtStat), pBreak, rateOld:p1, rateNew:p2 };
}

// ════════════════════════════════════════════════════════════════════════════
//  Two-Sided CUSUM
// ════════════════════════════════════════════════════════════════════════════
class TwoSidedCUSUM {
    constructor(config) {
        this.slack   = config.cusum_slack;
        this.upThr   = config.cusum_up_threshold;
        this.downThr = config.cusum_down_threshold;
        this.upC     = new Array(10).fill(0);
        this.downC   = new Array(10).fill(0);
        this.globalUp   = 0;
        this.globalDown = 0;
    }
    update(digit, isRepeat, p0 = 0.10, p1 = 0.40) {
        const logLR = Math.log((isRepeat ? p1:(1-p1)) / ((isRepeat ? p0:(1-p0))+1e-300)+1e-300);
        this.upC[digit]   = Math.max(0, this.upC[digit]   + logLR - this.slack);
        this.downC[digit] = Math.min(0, this.downC[digit] + logLR + this.slack);
        this.globalUp     = Math.max(0, this.globalUp     + logLR - this.slack);
        this.globalDown   = Math.min(0, this.globalDown   + logLR + this.slack);
    }
    resetDigit(d) { this.upC[d] = 0; this.downC[d] = 0; }
    resetGlobal() { this.globalUp = 0; this.globalDown = 0; }
    upAlarm(digit)      { return this.upC[digit] > this.upThr || this.globalUp > this.upThr; }
    downConfirmed(digit){ return this.downC[digit] < this.downThr && this.globalDown < this.downThr; }
}

// ════════════════════════════════════════════════════════════════════════════
//  Regime Detector (per asset)
// ════════════════════════════════════════════════════════════════════════════
class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg     = config;
        this.bocpd   = new BOCPD(config);
        this.hmm     = new BinaryHMM(config);
        this.ewma    = new EWMAStack();
        this.cusum   = new TwoSidedCUSUM(config);
        this.perDigitRate = new Array(10).fill(10);
        this.repeatBuffer = [];
        this.BUFFER_MAX   = 500;
        this.weights = { bocpd:1.0, hmm:1.0, ewma:1.0, acf:0.7, structural:0.6, cusum:1.0 };
        this.ticksSinceRefit = 0;
        this.hmmResult  = null;
        this.bocpdResult= null;
    }
    computePerDigitRepeatRate(window) {
        const transFrom   = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);
        for (let i = 0; i < window.length - 1; i++) {
            transFrom[window[i]]++;
            if (window[i+1] === window[i]) transRepeat[window[i]]++;
        }
        return transFrom.map((n,d) => n > 0 ? (transRepeat[d]/n)*100 : 10);
    }
    tick(prevDigit, curDigit) {
        const isRepeat   = prevDigit === curDigit;
        const obs_binary = isRepeat ? 1 : 0;
        this.bocpdResult = this.bocpd.update(obs_binary);
        this.ewma.update(obs_binary);
        this.cusum.update(prevDigit, isRepeat, 0.10, 0.40);
        this.repeatBuffer.push(obs_binary);
        if (this.repeatBuffer.length > this.BUFFER_MAX) this.repeatBuffer.shift();
        this.ticksSinceRefit++;
    }
    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len    = window.length;
        if (len < this.cfg.min_ticks_for_analysis)
            return { valid:false, reason:`insufficient data (${len}/${this.cfg.min_ticks_for_analysis})` };

        const binaryObs = this.hmm.buildObs(window);

        if (!this.hmm.fitted || this.ticksSinceRefit >= this.cfg.hmm_refit_every) {
            this.hmm.baumWelch(binaryObs);
            this.ticksSinceRefit = 0;
        }

        const vit = this.hmm.viterbi(binaryObs);
        if (!vit) return { valid:false, reason:'viterbi failed' };

        // Forward pass
        let logA = [Math.log(this.hmm.pi[0]+1e-300), Math.log(this.hmm.pi[1]+1e-300)];
        logA[0] += Math.log(this.hmm.B[0][binaryObs[0]]+1e-300);
        logA[1] += Math.log(this.hmm.B[1][binaryObs[0]]+1e-300);
        for (let t = 1; t < binaryObs.length; t++) {
            const nA = [0,1].map(s => {
                const inc = [0,1].map(p => logA[p]+Math.log(this.hmm.A[p][s]+1e-300));
                return logSumExp(inc)+Math.log(this.hmm.B[s][binaryObs[t]]+1e-300);
            });
            logA = nA;
        }
        const denom = logSumExp(logA);
        const posteriorNR  = Math.exp(logA[0]-denom);
        const posteriorRep = Math.exp(logA[1]-denom);

        const rawRepeatProb = this.computePerDigitRepeatRate(window);
        const shortWin   = window.slice(-20);
        const shortRepeats = shortWin.slice(1).filter((d,i) => d === shortWin[i]).length;
        const recentRate = (shortRepeats/(shortWin.length-1))*100;

        const acfWindow = this.repeatBuffer.slice(-Math.min(this.repeatBuffer.length,200));
        const acf       = computeACF(acfWindow, 5);
        const breakBuf  = this.repeatBuffer.slice(-100);
        const breakResult = structuralBreakTest(breakBuf);
        const bocpd     = this.bocpdResult || { pNonRep:0.5, expectedRL:0, modeRL:0, thetaEstimate:0.1, pChangepoint:0.5 };
        const ewmaValues = [0,1,2,3].map(i => this.ewma.get(i));
        const ewmaTrend  = this.ewma.trend();
        const cusumUpAlarm   = this.cusum.upAlarm(targetDigit);
        const cusumDownConfirm = this.cusum.downConfirmed(targetDigit);
        const threshold  = this.cfg.repeat_threshold;
        const w = this.weights;

        const bocpdScore = (() => {
            if (!this.bocpd.isNonRepRegime()) return 0;
            const rl = Math.min(bocpd.modeRL,150)/150;
            return rl * 25 * w.bocpd;
        })();
        const hmmScore = (() => {
            if (vit.currentState !== 0) return 0;
            const persist   = clamp(vit.persistence/this.cfg.min_regime_persistence,0,1);
            const stability = vit.stability;
            const posterior = clamp((posteriorNR-0.5)/0.5,0,1);
            return ((persist*0.4+stability*0.3+posterior*0.3)*25)*w.hmm;
        })();
        const ewmaScore = (() => {
            const allBelow = ewmaValues.every(v => v < threshold);
            if (!allBelow) return 0;
            const trendOk = ewmaTrend <= this.cfg.ewma_trend_threshold;
            const score   = trendOk ? 1.0 : 0.5;
            const margin  = Math.min(...ewmaValues.map(v => Math.max(0,threshold-v)))/threshold;
            return (score*0.7+margin*0.3)*20*w.ewma;
        })();
        const acfScore = (() => {
            const lag1 = acf[0] ?? 0;
            if (lag1 >= this.cfg.acf_lag1_threshold) return 0;
            const score = clamp(1-lag1/this.cfg.acf_lag1_threshold,0,1);
            const bonus = lag1 < 0 ? 0.1 : 0;
            return Math.min(1,score+bonus)*15*w.acf;
        })();
        const breakScore = (() => {
            if (breakResult.pBreak > this.cfg.structural_break_threshold) return 0;
            return (1-breakResult.pBreak/this.cfg.structural_break_threshold)*10*w.structural;
        })();
        const cusumScore = (() => {
            if (cusumUpAlarm) return 0;
            return (3 + (cusumDownConfirm ? 2 : 0))*w.cusum;
        })();

        let rawScore = bocpdScore+hmmScore+ewmaScore+acfScore+breakScore+cusumScore;
        if (vit.currentState !== 0)                                              rawScore = 0;
        if (posteriorNR < this.cfg.hmm_nonrep_confidence)                       rawScore = Math.min(rawScore,30);
        if (rawRepeatProb[targetDigit] >= threshold)                             rawScore = 0;
        if (this.ewma.get(0) >= threshold || this.ewma.get(1) >= threshold)     rawScore = 0;
        if (cusumUpAlarm)                                                        rawScore = 0;
        if (bocpd.pChangepoint > 0.3)                                           rawScore = Math.min(rawScore,25);
        if (ewmaTrend > this.cfg.ewma_trend_threshold * 2)                      rawScore = 0;

        const safetyScore = Math.round(clamp(rawScore,0,100));

        const signalActive = (
            vit.currentState === 0 &&
            posteriorNR >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            this.bocpd.isNonRepRegime() &&
            bocpd.pNonRep >= this.cfg.bocpd_nonrep_confidence &&
            bocpd.modeRL  >= this.cfg.bocpd_min_run_for_signal &&
            rawRepeatProb[targetDigit] < threshold &&
            this.ewma.get(0) < threshold && this.ewma.get(1) < threshold &&
            ewmaTrend <= this.cfg.ewma_trend_threshold &&
            (acf[0] ?? 0) < this.cfg.acf_lag1_threshold &&
            !cusumUpAlarm &&
            breakResult.pBreak < this.cfg.structural_break_threshold &&
            safetyScore >= this.cfg.repeat_confidence
        );

        return {
            valid:true,
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            hmmStability:   vit.stability,
            posteriorNR, posteriorRep,
            hmmDiscrim: this.hmm.lastFitDiscrim,
            hmmB_repeatNR:  this.hmm.repeatEmission(0),
            hmmB_repeatREP: this.hmm.repeatEmission(1),
            bocpdPNonRep: bocpd.pNonRep, bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL, bocpdTheta: bocpd.thetaEstimate,
            bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(),
            ewmaValues, ewmaTrend, acf,
            structBreak: breakResult,
            cusumUpAlarm, cusumDownConfirm,
            cusumUp: this.cusum.upC[targetDigit],
            cusumDown: this.cusum.downC[targetDigit],
            cusumGlobalUp: this.cusum.globalUp,
            rawRepeatProb, recentRate,
            componentScores: { bocpdScore, hmmScore, ewmaScore, acfScore, breakScore, cusumScore },
            safetyScore, signalActive,
        };
    }
    applyTradeFeedback(won) {
        const decay = 0.85, restore = 1.02;
        if (!won) for (const k of Object.keys(this.weights)) this.weights[k] = Math.max(0.5, this.weights[k]*decay);
        else      for (const k of Object.keys(this.weights)) this.weights[k] = Math.min(1.0, this.weights[k]*restore);
    }
    resetCUSUM(digit) { this.cusum.resetDigit(digit); }
}

// ════════════════════════════════════════════════════════════════════════════
//  Per-Asset State
// ════════════════════════════════════════════════════════════════════════════
function makeAssetState(config) {
    return {
        tickHistory:    [],
        prevDigit:      -1,
        detector:       new AdvancedRegimeDetector(config),
        regime:         null,
        targetDigit:    -1,
        targetRepeatRate: 0,
        signalActive:   false,
        currentStake:   config.base_stake,
        martingaleStep: 0,
        totalMartingaleLoss: 0,
        isTradeActive:  false,
        lastBuyPrice:   0,
        lastContractId: null,
        pendingTrade:   false,
        tradeOpenTime:  0,
        ghostConsecutiveWins: 0,
        ghostRoundsPlayed:    0,
        ghostConfirmed:       false,
        ghostAwaitingResult:  false,
        ghostTickCount:       0,
        botState:       'COLLECTING_TICKS',
        cooldownTimer:  null,
        tickSubscriptionId: null,
        historyLoaded:  false,
        currentWinStreak:  0,
        currentLossStreak: 0,
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN BOT
// ════════════════════════════════════════════════════════════════════════════
class RomanianGhostBotV4 {
    constructor(config) {
        this.config = config;

        // WebSocket
        this.ws               = null;
        this.connected        = false;
        this.wsReady          = false;
        this.reconnectAttempts= 0;
        this.isReconnecting   = false;
        this.reconnectTimer   = null;
        this.requestId        = 0;

        // Monitoring
        this.pingInterval     = null;
        this.checkDataInterval= null;
        this.pongTimeout      = null;
        this.lastPongTime     = Date.now();
        this.lastDataTime     = Date.now();

        // Message queue
        this.messageQueue     = [];
        this.MAX_QUEUE        = 100;

        // Account
        this.accountBalance   = 0;
        this.startingBalance  = 0;
        this.accountId        = '';

        // Global stats
        this.sessionProfit    = 0;
        this.totalTrades      = 0;
        this.totalWins        = 0;
        this.totalLosses      = 0;
        this.maxWinStreak     = 0;
        this.maxLossStreak    = 0;
        this.maxMartingaleReached = 0;
        this.largestWin       = 0;
        this.largestLoss      = 0;
        this.sessionStartTime = Date.now();
        this.endOfDay         = false;

        // One trade at a time globally
        this.globalTradeInProgress = false;
        this.activeTradeAsset      = null;

        // Per-asset states
        this.assetStates = {};
        for (const asset of config.assets)
            this.assetStates[asset] = makeAssetState(config);

        // Contract tracking: contractId → asset
        this.contractToAsset = {};

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        this.hourlyStats = { trades:0, wins:0, losses:0, pnl:0 };

        // Load persisted state before starting
        StatePersistence.load(this);
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async sendTelegram(text) {
        try { await this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode:'HTML' }); }
        catch (_) { }
    }

    startTelegramTimer() {
        const now      = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours()+1, 0, 0, 0);
        const wait = nextHour.getTime() - now.getTime();
        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 3600000);
        }, wait);
        logBot(`Telegram hourly summary in ${Math.ceil(wait/60000)}min`);
    }

    async sendHourlySummary() {
        const s = this.hourlyStats;
        const wr = s.trades > 0 ? ((s.wins/s.trades)*100).toFixed(1) : '0.0';
        const msg = `
                ⏰ <b>Ghost Bot v4 — Hourly Summary</b>

                📊 <b>Last Hour</b>
                ├ Trades: ${s.trades}
                ├ Wins: ${s.wins} | Losses: ${s.losses}
                ├ Win Rate: ${wr}%
                └ ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${s.pnl >= 0?'+':''}$${s.pnl.toFixed(2)}

                📈 <b>Session Totals</b>
                ├ Total Trades: ${this.totalTrades}
                ├ Total W/L: ${this.totalWins}/${this.totalLosses}
                ├ Session P&L: ${this.sessionProfit >= 0?'+':''}$${this.sessionProfit.toFixed(2)}
                └ Balance: $${this.accountBalance.toFixed(2)}
            `.trim();
        await this.sendTelegram(msg);
        this.hourlyStats = { trades:0, wins:0, losses:0, pnl:0 };
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    start() {
        this.printBanner();
        this.connect();
        this.startTelegramTimer();
        StatePersistence.startAutoSave(this);
        this.startWeekendScheduler();
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        this.cleanup();
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)}...`);
        try { this.ws = new WebSocket(url); }
        catch(e) { logError(`WS create: ${e.message}`); this.scheduleReconnect(); return; }

        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.connected = true; this.wsReady = false;
            this.reconnectAttempts = 0; this.isReconnecting = false;
            this.lastPongTime = Date.now(); this.lastDataTime = Date.now();
            this.startMonitor();
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            this.lastPongTime = Date.now(); this.lastDataTime = Date.now();
            try { this.handleMessage(JSON.parse(raw)); }
            catch(e) { logError(`Parse: ${e.message}`); }
        });

        this.ws.on('close', (code, reason) => {
            logApi(`WS closed (${code}) ${reason||''}`);
            this.handleDisconnect();
        });

        this.ws.on('error', e => logError(`WS error: ${e.message}`));
        this.ws.on('pong', () => { this.lastPongTime = Date.now(); });
    }

    startMonitor() {
        this.stopMonitor();
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
                this.send({ ping: 1 });
            }
        }, this.config.ping_interval_ms);

        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;
            const silence = Date.now() - this.lastDataTime;
            if (silence > this.config.data_timeout_ms) {
                logError(`No data for ${Math.round(silence/1000)}s — forcing reconnect`);
                StatePersistence.save(this);
                this.ws?.terminate();
            }
        }, 10000);
    }

    stopMonitor() {
        if (this.pingInterval)      { clearInterval(this.pingInterval);      this.pingInterval = null; }
        if (this.checkDataInterval) { clearInterval(this.checkDataInterval); this.checkDataInterval = null; }
        if (this.pongTimeout)       { clearTimeout(this.pongTimeout);        this.pongTimeout = null; }
    }

    cleanup() {
        this.stopMonitor();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) {
            this.ws.removeAllListeners();
            if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState))
                try { this.ws.close(); } catch(_) {}
            this.ws = null;
        }
        this.connected = false; this.wsReady = false;
    }

    handleDisconnect() {
        if (this.endOfDay) { logBot('Planned shutdown, not reconnecting'); this.cleanup(); return; }
        if (this.isReconnecting) return;
        this.connected = false; this.wsReady = false;
        this.stopMonitor();
        StatePersistence.save(this);
        this.isReconnecting = true;
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.config.max_reconnect_attempts) {
            logError('Max reconnect attempts reached');
            this.sendTelegram('❌ <b>Max Reconnect Attempts</b>\nPlease restart the bot.');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.reconnect_base_delay * Math.pow(1.5, this.reconnectAttempts - 1),
            30000
        );
        logApi(`Reconnect in ${(delay/1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
        this.sendTelegram(
            `⚠️ <b>Reconnecting</b>\nAttempt ${this.reconnectAttempts} in ${(delay/1000).toFixed(1)}s\n` +
            `P&L: ${formatMoney(this.sessionProfit)}`
        );
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.messageQueue.length < this.MAX_QUEUE) this.messageQueue.push(payload);
            return false;
        }
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); return true; }
        catch(e) {
            logError(`Send: ${e.message}`);
            if (this.messageQueue.length < this.MAX_QUEUE) this.messageQueue.push(payload);
            return false;
        }
    }

    processMessageQueue() {
        if (!this.messageQueue.length) return;
        logBot(`Processing ${this.messageQueue.length} queued messages`);
        const q = [...this.messageQueue]; this.messageQueue = [];
        q.forEach(m => this.send(m));
    }

    // ── Message Handling ──────────────────────────────────────────────────────
    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch(msg.msg_type) {
            case 'authorize':             this.handleAuth(msg); break;
            case 'balance':               this.handleBalance(msg); break;
            case 'history':               this.handleTickHistory(msg); break;
            case 'tick':                  this.handleTick(msg); break;
            case 'buy':                   this.handleBuy(msg); break;
            case 'transaction':           this.handleTransaction(msg); break;
            // proposal_open_contract is kept as a safety net but transaction is primary
            case 'proposal_open_contract':this.handleOpenContract(msg); break;
            case 'ping':                  break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        logError(`[${code}] on ${msg.msg_type||'?'}: ${msg.error.message}`);
        if (['InvalidToken','AuthorizationRequired'].includes(code)) {
            this.stop('Auth failed'); return;
        }
        if (code === 'InsufficientBalance') { this.stop('Insufficient balance'); return; }
        if (msg.msg_type === 'buy') {
            const asset = this.activeTradeAsset;
            if (asset) {
                this.assetStates[asset].isTradeActive = false;
                this.assetStates[asset].botState = 'ANALYZING';
            }
            this.globalTradeInProgress = false;
            this.activeTradeAsset = null;
        }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        this.accountBalance  = parseFloat(msg.authorize.balance);
        if (!this.startingBalance) this.startingBalance = this.accountBalance;
        this.accountId = msg.authorize.loginid || 'N/A';
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Auth')} | ${bold(this.accountId)} ${isDemo ? dim('(Demo)') : red('(REAL)')} | $${this.accountBalance.toFixed(2)}`);
        this.wsReady = true;
        this.processMessageQueue();
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.initializeAssets();
    }

    initializeAssets() {
        logBot(`Initializing ${this.config.assets.length} assets...`);
        for (const asset of this.config.assets) {
            this.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.tick_history_size,
                end: 'latest', start: 1, style: 'ticks'
            });
            this.send({ ticks: asset, subscribe: 1 });
        }
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    handleTickHistory(msg) {
        if (!msg.history?.prices) return;
        const asset  = msg.echo_req.ticks_history;
        const as     = this.assetStates[asset];
        if (!as) return;

        const digits = msg.history.prices.map(p => getLastDigit(p, asset));
        // Merge with any pre-loaded (from persistence) history
        const merged = [...as.tickHistory, ...digits];
        as.tickHistory = merged.slice(-this.config.tick_history_size);
        as.historyLoaded = true;

        logBot(`${green('✅')} ${bold(asset)} loaded ${as.tickHistory.length} ticks`);

        // Warm up detectors
        for (let i = 1; i < as.tickHistory.length; i++)
            as.detector.tick(as.tickHistory[i-1], as.tickHistory[i]);

        if (as.tickHistory.length >= this.config.min_ticks_for_analysis) {
            as.prevDigit = as.tickHistory[as.tickHistory.length - 1];
            as.botState  = 'ANALYZING';
        }
    }

    handleTick(msg) {
        if (!msg.tick) return;
        const asset  = msg.tick.symbol;
        const as     = this.assetStates[asset];
        if (!as) return;

        if (msg.subscription) as.tickSubscriptionId = msg.subscription.id;

        const curDigit  = getLastDigit(msg.tick.quote, asset);
        const prevDigit = as.prevDigit;

        as.tickHistory.push(curDigit);
        if (as.tickHistory.length > this.config.tick_history_size)
            as.tickHistory = as.tickHistory.slice(-this.config.tick_history_size);

        // Always update incremental detectors — cheap O(1) per tick
        if (prevDigit >= 0) as.detector.tick(prevDigit, curDigit);
        as.prevDigit = curDigit;

        logTick(dim(`[${asset}]`) + ` ${bold(cyan('['+curDigit+']'))} ${dim(msg.tick.quote)}`);

        // Skip heavy logic until history is loaded
        if (!as.historyLoaded || as.botState === 'STOPPED') return;

        // Transition out of COLLECTING_TICKS once we have enough data
        if (as.botState === 'COLLECTING_TICKS') {
            if (as.tickHistory.length >= this.config.min_ticks_for_analysis) as.botState = 'ANALYZING';
            else return;
        }

        // WAITING_RESULT: trade is live — just track ticks, no analysis
        if (as.botState === 'WAITING_RESULT') return;

        // COOLDOWN: just accumulate ticks, timer handles the state change
        if (as.botState === 'COOLDOWN') return;

        // Pending trade: fire on very next tick (no digit-matching wait)
        // The signal was already validated; any tick is fine for a 1-tick contract
        if (as.pendingTrade && !as.isTradeActive && !this.globalTradeInProgress) {
            as.pendingTrade = false;
            this.placeTrade(asset);
            return;
        }

        // Don't run heavy analysis on non-active assets while a trade is live
        if (this.globalTradeInProgress && this.activeTradeAsset !== asset) return;

        switch(as.botState) {
            case 'ANALYZING':
                this.runAnalysis(asset, curDigit);
                break;
            case 'GHOST_TRADING':
                // Only re-analyze every 5 ticks during ghost phase to reduce CPU
                as.ghostTickCount = (as.ghostTickCount || 0) + 1;
                if (as.ghostTickCount % 5 === 0 || as.ghostConsecutiveWins === 0) {
                    as.regime = as.detector.analyze(as.tickHistory, as.targetDigit);
                    this.refreshSignal(asset);
                }
                this.runGhostCheck(asset, curDigit);
                break;
        }
    }

    runAnalysis(asset, curDigit) {
        const as = this.assetStates[asset];
        if (this.globalTradeInProgress) return; // One trade at a time globally

        as.regime = as.detector.analyze(as.tickHistory, curDigit);
        if (!as.regime?.valid) return;

        as.targetDigit      = curDigit;
        as.targetRepeatRate = as.regime.rawRepeatProb[curDigit];
        as.signalActive     = as.regime.signalActive;

        this.logRegimeAnalysis(asset, curDigit);

        if (as.signalActive) this.processSignal(asset, curDigit);
    }

    refreshSignal(asset) {
        const as = this.assetStates[asset];
        if (as.targetDigit < 0 || !as.regime?.valid) return;
        as.targetRepeatRate = as.regime.rawRepeatProb[as.targetDigit];
        as.signalActive     = as.regime.signalActive;
    }

    // ── Ghost Trading ─────────────────────────────────────────────────────────
    processSignal(asset, curDigit) {
        const as = this.assetStates[asset];
        if (!as.signalActive) { as.botState = 'ANALYZING'; return; }
        if (this.config.ghost_enabled && !as.ghostConfirmed) {
            as.botState = 'GHOST_TRADING';
            logGhost(`[${asset}] 👻 Ghost started. Target:${bold(cyan(as.targetDigit))} Score:${as.regime.safetyScore}/100`);
            this.runGhostCheck(asset, curDigit);
        } else {
            this.executeTradeFlow(asset, true);
        }
    }

    runGhostCheck(asset, curDigit) {
        const as = this.assetStates[asset];
        if (as.botState !== 'GHOST_TRADING') return;
        if (!as.signalActive) {
            logGhost(dim(`[${asset}] Signal lost — re-analyzing`));
            this.resetGhost(asset); as.botState = 'ANALYZING'; return;
        }
        as.ghostRoundsPlayed++;
        if (as.ghostAwaitingResult) {
            as.ghostAwaitingResult = false;
            if (curDigit !== as.targetDigit) {
                as.ghostConsecutiveWins++;
                logGhost(`[${asset}] 👻 ${green(`Ghost WIN ${as.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
            } else {
                const had = as.ghostConsecutiveWins; as.ghostConsecutiveWins = 0;
                logGhost(`[${asset}] 👻 ${red('Ghost LOSS — REPEATED')} (had ${had})`);
            }
        } else {
            if (curDigit === as.targetDigit) {
                const wic = as.ghostConsecutiveWins + 1;
                if (wic >= this.config.ghost_wins_required) {
                    as.ghostConsecutiveWins = wic; as.ghostConfirmed = true;
                    logGhost(green(`[${asset}] ✅ Ghost confirmed! Trading digit ${as.targetDigit}`));
                    this.executeTradeFlow(asset, true);
                } else {
                    as.ghostAwaitingResult = true;
                    logGhost(`[${asset}] 👻 Digit appeared. Wins:${as.ghostConsecutiveWins}/${this.config.ghost_wins_required}`);
                }
            } else {
                this.refreshSignal(asset);
                if (!as.signalActive) { this.resetGhost(asset); as.botState = 'ANALYZING'; }
            }
        }
        if (!as.ghostConfirmed && as.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`[${asset}] ⚠️ Max ghost rounds — re-analyzing`));
            this.resetGhost(asset); as.botState = 'ANALYZING';
        }
    }

    resetGhost(asset) {
        const as = this.assetStates[asset];
        as.ghostConsecutiveWins = 0; as.ghostRoundsPlayed  = 0;
        as.ghostConfirmed = false;   as.ghostAwaitingResult= false;
        as.targetDigit    = -1;      as.signalActive       = false;
    }

    // ── Trade Execution ───────────────────────────────────────────────────────
    executeTradeFlow(asset, immediate) {
        const as = this.assetStates[asset];
        if (as.isTradeActive || as.pendingTrade) return;
        if (this.globalTradeInProgress) return; // One trade at a time
        if (this.endOfDay) return;

        const risk = this.checkRiskLimits(asset);
        if (!risk.canTrade) {
            logRisk(`[${asset}] ${risk.reason}`);
            if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(asset); return; }
            return;
        }
        as.currentStake = this.calculateStake(asset);
        if (as.currentStake > this.config.max_stake) { this.stop('Stake > max'); return; }
        if (as.currentStake > this.accountBalance)    { this.stop('Insufficient balance'); return; }

        if (immediate) {
            // Fire immediately on the signal tick — no digit-matching wait
            this.placeTrade(asset);
        } 
        // else {
        //     // Martingale recovery: queue to fire on the very next tick
        //     as.pendingTrade = true;
        //     logBot(`[${asset}] Recovery trade queued — fires on next tick`);
        // }
    }

    // Helper: get last N digits as display string
    getLastDigitsStr(asset, n = 10) {
        const as = this.assetStates[asset];
        return as.tickHistory.slice(-n).join(', ');
    }

    placeTrade(asset) {
        const as = this.assetStates[asset];
        if (this.globalTradeInProgress) return;
        as.isTradeActive          = true;
        as.botState               = 'WAITING_RESULT';
        as.tradeOpenTime          = Date.now();
        this.globalTradeInProgress = true;
        this.activeTradeAsset      = asset;

        const r     = as.regime;
        const score = r?.valid ? r.safetyScore : 0;
        const pnr   = r?.valid ? (r.posteriorNR * 100).toFixed(1) + '%' : '?';
        const bocRL = r?.valid ? r.bocpdModeRL : '?';
        const last10 = this.getLastDigitsStr(asset, 10);

        logTrade(
            `[${bold(asset)}] 🎯 DIFFER from ${bold(cyan(as.targetDigit))} | ` +
            `$${as.currentStake.toFixed(2)} | Rate:${as.targetRepeatRate.toFixed(1)}% | ` +
            `Score:${score}/100 | P(NR):${pnr} | RL:${bocRL}t | ` +
            `Mart:${as.martingaleStep}/${this.config.max_martingale_steps} | ` +
            `Last10:[${last10}]`
        );

        this.sendTelegram(`
            🎯 <b>TRADE PLACED v4</b>

            📊 <b>${asset}</b>
            🎯 Differ: <b>${as.targetDigit}</b>
            🔢 Digits: ${last10}
            💰 Stake: $${as.currentStake.toFixed(2)} [Step ${as.martingaleStep}]
            📈 Rate: ${as.targetRepeatRate.toFixed(1)}% | Score: ${score}/100
            🔬 P(NR): ${pnr} 
            🔬 BOCPD_RL: ${bocRL}t
        `
        );

        // Send buy request immediately — result comes via transaction subscription
        this.send({
            buy: 1, price: as.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: asset, duration: 1, duration_unit: 't',
                basis: 'stake', amount: as.currentStake,
                barrier: String(as.targetDigit),
                currency: this.config.currency,
            }
        });
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        const asset = this.activeTradeAsset;
        if (!asset) return;
        const as = this.assetStates[asset];
        as.lastContractId = msg.buy.contract_id;
        as.lastBuyPrice   = parseFloat(msg.buy.buy_price);
        this.contractToAsset[msg.buy.contract_id] = asset;
        logTrade(dim(`[${asset}] Contract ${as.lastContractId} | Cost:$${as.lastBuyPrice.toFixed(2)} | Payout:$${parseFloat(msg.buy.payout).toFixed(2)}`));
        // DO NOT subscribe to proposal_open_contract — adds latency.
        // The 'transaction' sell event (already subscribed at auth) fires fastest.
    }

    handleTransaction(msg) {
        // PRIMARY result handler — 'transaction' sell fires as soon as contract settles
        if (!msg.transaction || msg.transaction.action !== 'sell') return;
        if (!this.globalTradeInProgress) return;
        const contractId = msg.transaction.contract_id;
        // Match by contract id if available, else use activeTradeAsset
        const asset = this.contractToAsset[contractId] || this.activeTradeAsset;
        if (!asset) return;
        const as = this.assetStates[asset];
        if (!as.isTradeActive) return; // Already processed (e.g. by handleOpenContract)
        delete this.contractToAsset[contractId];

        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - as.lastBuyPrice;
        const won    = profit > 0;

        const elapsed = Date.now() - (as.tradeOpenTime || Date.now());
        logResult(dim(`[${asset}] Result via transaction in ${elapsed}ms`));
        this.processTradeResult(asset, won, profit, as.lastBuyPrice);
    }

    handleOpenContract(msg) {
        // FALLBACK handler — only used if transaction event missed
        if (!msg.proposal_open_contract?.is_sold) return;
        const poc   = msg.proposal_open_contract;
        const asset = this.contractToAsset[poc.contract_id];
        if (!asset) return; // Already handled by transaction
        const as    = this.assetStates[asset];
        if (!as.isTradeActive) return; // Already processed
        delete this.contractToAsset[poc.contract_id];
        const profit = parseFloat(poc.profit);
        const won    = poc.status === 'won';
        logResult(dim(`[${asset}] Result via proposal_open_contract (fallback)`));
        this.processTradeResult(asset, won, profit, as.lastBuyPrice);
    }

    processTradeResult(asset, won, profit, cost) {
        const as = this.assetStates[asset];
        if (!as.isTradeActive) return; // Already processed
        as.isTradeActive = false;
        this.globalTradeInProgress = false;
        this.activeTradeAsset = null;

        this.totalTrades++;
        this.hourlyStats.trades++;

        const last10 = this.getLastDigitsStr(asset, 10);
        // The result digit is the most recent tick for this asset
        const resultDigit = as.tickHistory[as.tickHistory.length - 1];

        if (won) {
            this.totalWins++;
            this.sessionProfit += profit;
            this.hourlyStats.wins++;
            this.hourlyStats.pnl += profit;
            as.currentWinStreak++; as.currentLossStreak = 0;
            if (as.currentWinStreak > this.maxWinStreak) this.maxWinStreak = as.currentWinStreak;
            if (profit > this.largestWin) this.largestWin = profit;
            as.detector.applyTradeFeedback(true);
            as.detector.resetCUSUM(as.targetDigit);
            this.resetMartingale(asset);
            this.resetGhost(asset);
            as.botState = 'ANALYZING';

            logResult(`[${asset}] ${green('✅ WIN!')} +$${profit.toFixed(2)} | Target:${as.targetDigit} Result:${resultDigit} | P/L:${formatMoney(this.sessionProfit)} | Bal:$${this.accountBalance.toFixed(2)}`);
            this.sendTelegram(`
                    ✅ <b>WIN! v4</b>

                    📊 <b>${asset}</b>
                    🎯 Target: ${as.targetDigit} | Result: ${resultDigit}
                    🔢 Digits: ${last10}
                    💰 +$${profit.toFixed(2)}
                    📊 ${this.totalWins}W/${this.totalLosses}L | WStreak:${as.currentWinStreak}
                    📈 Trades: ${this.totalTrades} | ${formatMoney(this.sessionProfit)}
                `
            );
        } else {
            // cost = stake amount lost
            const lostAmount = cost;
            this.totalLosses++;
            this.sessionProfit -= lostAmount;
            this.hourlyStats.losses++;
            this.hourlyStats.pnl -= lostAmount;
            as.currentLossStreak++; as.currentWinStreak = 0;
            if (as.currentLossStreak > this.maxLossStreak) this.maxLossStreak = as.currentLossStreak;
            if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
            as.martingaleStep++;
            if (as.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = as.martingaleStep;
            as.detector.applyTradeFeedback(false);
            as.ghostConsecutiveWins = 0; as.ghostConfirmed = false;

            logResult(`[${asset}] ${red('❌ LOSS!')} -$${lostAmount.toFixed(2)} | Target:${as.targetDigit} Result:${resultDigit} ${resultDigit === as.targetDigit ? red('REPEATED!') : ''} | Mart:${as.martingaleStep}/${this.config.max_martingale_steps} | P/L:${formatMoney(this.sessionProfit)}`);
            this.sendTelegram(`
                    ❌ <b>LOSS! v4</b>

                    📊 <b>${asset}</b>
                    🎯 Target: ${as.targetDigit} | Result: ${resultDigit}${resultDigit === as.targetDigit ? ' 🔁 REPEATED' : ''}
                    🔢 Digits: ${last10}
                    💸 -$${lostAmount.toFixed(2)}
                    📊 ${this.totalWins}W/${this.totalLosses}L | Mart: ${as.martingaleStep}/${this.config.max_martingale_steps}
                    📈 Trades: ${this.totalTrades} | ${formatMoney(this.sessionProfit)}
                `
            );
            this.decideNextAction(asset);
        }

        // Check global risk after every trade
        const globalRisk = this.checkGlobalRisk();
        if (!globalRisk.canTrade && globalRisk.action === 'STOP')
            this.stop(globalRisk.reason);
    }

    decideNextAction(asset) {
        const as = this.assetStates[asset];
        if (this.config.martingale_enabled && as.martingaleStep > 0 && as.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`[${asset}] Martingale recovery step ${as.martingaleStep}/${this.config.max_martingale_steps}`));
            as.botState = this.config.ghost_enabled ? 'GHOST_TRADING' : 'ANALYZING';
            if (!this.config.ghost_enabled) this.executeTradeFlow(asset, false);
            return;
        }
        if (this.config.martingale_enabled && as.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`[${asset}] 🛑 Max Martingale steps!`);
            this.resetMartingale(asset);
            this.startCooldown(asset);
            return;
        }
        as.botState = 'ANALYZING';
    }

    // ── Risk & Stake ──────────────────────────────────────────────────────────
    calculateStake(asset) {
        const as = this.assetStates[asset];
        if (!this.config.martingale_enabled || as.martingaleStep === 0) return this.config.base_stake;
        const raw   = this.config.base_stake * Math.pow(this.config.martingale_multiplier, as.martingaleStep);
        return Math.min(Math.round(raw * 100) / 100, this.config.max_stake);
    }

    checkRiskLimits(asset) {
        const as   = this.assetStates[asset];
        const ns   = this.calculateStake(asset);
        if (ns > this.accountBalance) return { canTrade:false, reason:'Next stake > balance', action:'STOP' };
        if (ns > this.config.max_stake) return { canTrade:false, reason:'Next stake > max', action:'STOP' };
        if (this.config.martingale_enabled && as.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade:false, reason:'Max Martingale steps', action:'COOLDOWN' };
        return { canTrade:true };
    }

    checkGlobalRisk() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade:false, reason:`🎯 Take profit! ${formatMoney(this.sessionProfit)}`, action:'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade:false, reason:`🛑 Stop loss! ${formatMoney(this.sessionProfit)}`, action:'STOP' };
        }
        return { canTrade:true };
    }

    resetMartingale(asset) {
        const as = this.assetStates[asset];
        as.martingaleStep = 0; as.totalMartingaleLoss = 0; as.currentStake = this.config.base_stake;
    }

    startCooldown(asset) {
        const as = this.assetStates[asset];
        as.botState = 'COOLDOWN';
        this.resetMartingale(asset); this.resetGhost(asset);
        logBot(`[${asset}] ⏸️  Cooldown ${this.config.cooldown_after_max_loss/1000}s`);
        if (as.cooldownTimer) clearTimeout(as.cooldownTimer);
        as.cooldownTimer = setTimeout(() => {
            if (as.botState === 'COOLDOWN') { logBot(`[${asset}] ▶️  Cooldown ended`); as.botState = 'ANALYZING'; }
        }, this.config.cooldown_after_max_loss);
    }

    // ── Weekend Scheduler ─────────────────────────────────────────────────────
    startWeekendScheduler() {
        setInterval(() => {
            const now = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const day  = gmt1.getUTCDay(), h = gmt1.getUTCHours(), m = gmt1.getUTCMinutes();
            const isWeekend = day === 0 || (day === 6 && h >= 23) || (day === 1 && h < 8);
            if (isWeekend && !this.endOfDay) {
                logBot('Weekend — disconnecting until Monday 08:00 GMT+1');
                this.sendHourlySummary();
                this.endOfDay = true;
                this.cleanup();
            }
            if (this.endOfDay && !isWeekend && h >= 8 && m >= 0) {
                logBot('08:00 GMT+1 — reconnecting');
                this.endOfDay = false;
                this.connect();
            }
        }, 20000);
    }

    // ── Stop ──────────────────────────────────────────────────────────────────
    stop(reason = 'User stopped') {
        logBot(`🛑 Stopping: ${reason}`);
        this.endOfDay = true;
        for (const asset of this.config.assets) {
            const as = this.assetStates[asset];
            if (as.cooldownTimer) { clearTimeout(as.cooldownTimer); as.cooldownTimer = null; }
        }
        StatePersistence.save(this);
        this.cleanup();
        this.sendTelegram(`🛑 <b>STOPPED</b>\nReason: ${reason}\nP&L: ${formatMoney(this.sessionProfit)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    logRegimeAnalysis(asset, curDigit) {
        const as  = this.assetStates[asset];
        const r   = as.regime;
        if (!r?.valid) return;
        const thr = this.config.repeat_threshold;
        const pnrPct = (r.posteriorNR*100).toFixed(1);

        const stateCol = r.hmmState === 0 ? green : yellow;
        logHMM(`[${asset}] HMM:${stateCol(bold(r.hmmStateName))} P(NR):${r.posteriorNR>=this.config.hmm_nonrep_confidence?green(pnrPct+'%'):red(pnrPct+'%')} Persist:${r.hmmPersistence}t`);
        logBocpd(`[${asset}] BOCPD P(NR):${r.bocpdIsNonRep?green((r.bocpdPNonRep*100).toFixed(1)+'%'):red((r.bocpdPNonRep*100).toFixed(1)+'%')} RL:${r.bocpdModeRL}t θ̂:${(r.bocpdTheta*100).toFixed(1)}%`);
        logRegime(`[${asset}] Score:${r.safetyScore>=this.config.repeat_confidence?green(bold(r.safetyScore+'/100')):red(r.safetyScore+'/100')} CUSUM:${r.cusumUpAlarm?red('ALARM'):green('ok')} EWMA:${r.ewmaValues.map((v,i)=>v<thr?green(v.toFixed(1)+'%'):red(v.toFixed(1)+'%')).join('|')}`);

        if (as.signalActive) {
            logAnalysis(green(bold(`[${asset}] ✅ SIGNAL — digit ${curDigit} | Score:${r.safetyScore} | P(NR):${pnrPct}% → DIFFER`)));
        }
    }

    printBanner() {
        console.log('');
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v4.0  —  Multi-Asset + Persistence     ')));
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log(`  Assets    : ${bold(this.config.assets.join(', '))}`);
        console.log(`  Base Stake: ${bold('$'+this.config.base_stake.toFixed(2))}`);
        console.log(`  Martingale: ${this.config.martingale_enabled ? green(`ON | ${this.config.max_martingale_steps} steps | ${this.config.martingale_multiplier}x`) : red('OFF')}`);
        console.log(`  Ghost     : ${this.config.ghost_enabled ? green('ON | wins:'+this.config.ghost_wins_required) : red('OFF')}`);
        console.log(`  Take Profit: ${green('$'+this.config.take_profit)} | Stop Loss: ${red('$'+this.config.stop_loss)}`);
        console.log(`  State File : ${dim(this.config.state_file)}`);
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log('');
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr  = this.totalTrades > 0 ? ((this.totalWins/this.totalTrades)*100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY               ')));
        logStats(bold(cyan('════════════════════════════════════════════')));
        logStats(`  Duration        : ${bold(formatDuration(dur))}`);
        logStats(`  Total Trades    : ${bold(this.totalTrades)}`);
        logStats(`  Wins / Losses   : ${green(this.totalWins)} / ${red(this.totalLosses)}`);
        logStats(`  Win Rate        : ${bold(wr+'%')}`);
        logStats(`  Session P/L     : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance: $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance   : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Avg P/L/Trade   : ${formatMoney(avg)}`);
        logStats(`  Largest Win     : ${green('+$'+this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss    : ${red('-$'+this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak  : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak : ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale  : Step ${this.maxMartingaleReached}`);
        logStats(bold(cyan('════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ───────────────────────────────────────────────────────────────
(function main() {
    const bot = new RomanianGhostBotV4(CONFIG);
    process.on('SIGINT',  () => { console.log(''); bot.stop('SIGINT'); });
    process.on('SIGTERM', () => bot.stop('SIGTERM'));
    process.on('uncaughtException', e => {
        logError(`Uncaught: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', r => logError(`Rejection: ${r}`));
    bot.start();
})();
