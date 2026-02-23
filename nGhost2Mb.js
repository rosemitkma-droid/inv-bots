#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v4.0 Multi-Asset Precision Regime Detection
//  Deriv Digit Differ — Multi-Asset Ensemble Regime Engine
//
//  UPGRADES from v3.0:
//    • Multi-Asset Trading: Scans multiple assets simultaneously, trades the best
//    • State Persistence: Saves/loads state to disk for crash recovery
//    • Detailed Telegram Notifications: Rich formatted messages for all events
//    • Asset Rotation: Switches to best-scoring asset dynamically
//    • Per-Asset Regime Detectors: Independent detector instances per symbol
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

// ── State persistence file ────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'ghost_bot_state.json');

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m', white: '\x1b[37m',
};
const col = (t, ...c) => c.join('') + t + C.reset;
const bold = t => col(t, C.bold);
const dim = t => col(t, C.dim);
const cyan = t => col(t, C.cyan);
const blue = t => col(t, C.blue);
const green = t => col(t, C.green);
const red = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta = t => col(t, C.magenta);

// ── Logger ────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: 'cyan', API: 'blue', TICK: 'dim', ANALYSIS: 'yellow',
    GHOST: 'magenta', TRADE: 'bold', RESULT: 'bold', RISK: 'red',
    STATS: 'cyan', ERROR: 'red+bold', HMM: 'orange', BOCPD: 'green',
    REGIME: 'magenta', ASSET: 'cyan', STATE: 'blue',
};
const loggers = {};
Object.keys(PREFIX_COLOURS).forEach(p => {
    const fn = {
        cyan: cyan, blue: blue, dim: dim, yellow: yellow, magenta: magenta,
        bold: bold, red: red, green: green, orange: t => col(t, C.orange),
        'red+bold': t => col(t, C.bold, C.red),
    }[PREFIX_COLOURS[p]] || (t => t);
    loggers[p] = m => {
        const ts = dim(`[${new Date().toTimeString().slice(0, 8)}]`);
        console.log(`${ts} ${fn(`[${p}]`)} ${m}`);
    };
});
const { BOT: logBot, API: logApi, TICK: logTick, ANALYSIS: logAnalysis,
    GHOST: logGhost, TRADE: logTrade, RESULT: logResult, RISK: logRisk,
    STATS: logStats, ERROR: logError, HMM: logHMM, BOCPD: logBocpd,
    REGIME: logRegime, ASSET: logAsset, STATE: logState } = loggers;

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',

        // ── Multi-Asset Configuration ─────────────────────────────────────────
        symbols: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBEAR', 'RDBULL'],
        asset_scan_interval: 10,       // Re-evaluate best asset every N ticks
        min_score_advantage: 5,        // Min score advantage to switch assets
        asset_lock_ticks: 30,          // Min ticks before allowing asset switch

        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // History
        tick_history_size: 5000,
        analysis_window: 3000,
        min_ticks_for_analysis: 100,

        // ── Regime detection thresholds ───────────────────────────────────────
        repeat_threshold: 9,
        hmm_nonrep_confidence: 0.75,
        bocpd_nonrep_confidence: 0.82,
        min_regime_persistence: 8,
        acf_lag1_threshold: 0.15,
        ewma_trend_threshold: 2.0,
        cusum_up_threshold: 3.5,
        cusum_down_threshold: -4.0,
        cusum_slack: 0.15,
        structural_break_threshold: 0.15,

        // BOCPD
        bocpd_hazard: 1 / 150,
        bocpd_prior_alpha: 1,
        bocpd_prior_beta: 9,
        bocpd_min_run_for_signal: 15,

        // Binary HMM
        hmm_refit_every: 50,
        hmm_min_discrimination: 0.10,

        // Ensemble
        repeat_confidence: 80,

        // Ghost
        ghost_enabled: false,
        ghost_wins_required: 1,
        ghost_max_rounds: 20000000000,

        // Martingale
        martingale_enabled: true,
        martingale_multiplier: 11.3,
        max_martingale_steps: 3,

        // Risk
        take_profit: 100,
        stop_loss: 70,
        max_stake: 500,
        delay_between_trades: 1500,
        cooldown_after_max_loss: 30000,

        // State persistence
        state_save_interval: 30000,    // Save state every 30s
        state_file: STATE_FILE,
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac = parts.length > 1 ? parts[1] : '';
    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50', 'R_100',
        '1HZ50V', '1HZ75V', '1HZ100V'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10', 'R_25', '1HZ10V', '1HZ15V', '1HZ25V',
        '1HZ30V', '1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}
function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

function binomialLogPMF(k, n, p) {
    if (p <= 0) return k === 0 ? 0 : -Infinity;
    if (p >= 1) return k === n ? 0 : -Infinity;
    let logC = 0;
    for (let i = 0; i < k; i++) logC += Math.log(n - i) - Math.log(i + 1);
    return logC + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

function betaIncomplete(x, a, b) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    return front * continuedFraction(x, a, b);
}
function lgamma(z) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function continuedFraction(x, a, b) {
    const MAX = 200; const EPS = 3e-7;
    let f = 1, Cv = 1, D = 1 - (a + b) * x / (a + 1);
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D; f = D;
    for (let m = 1; m <= MAX; m++) {
        let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
        D = 1 + aa * D; Cv = 1 + aa / Cv;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(Cv) < 1e-30) Cv = 1e-30;
        D = 1 / D; let delta = Cv * D; f *= delta;
        aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
        D = 1 + aa * D; Cv = 1 + aa / Cv;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(Cv) < 1e-30) Cv = 1e-30;
        D = 1 / D; delta = Cv * D; f *= delta;
        if (Math.abs(delta - 1) < EPS) break;
    }
    return f;
}

// ── State Constants ────────────────────────────────────────────────────────────
const BOT_STATE = {
    INITIALIZING: 'INITIALIZING', CONNECTING: 'CONNECTING', AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS', ANALYZING: 'ANALYZING', GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE', WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT', COOLDOWN: 'COOLDOWN', STOPPED: 'STOPPED',
};


// ══════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════
class StatePersistence {
    constructor(filePath) {
        this.filePath = filePath;
        this.backupPath = filePath + '.bak';
        this.saveTimer = null;
    }

    save(state) {
        try {
            const data = {
                version: '4.0',
                timestamp: Date.now(),
                timestampStr: new Date().toISOString(),
                ...state,
            };
            // Write to backup first, then rename (atomic-ish)
            const json = JSON.stringify(data, null, 2);
            fs.writeFileSync(this.backupPath, json, 'utf8');
            fs.renameSync(this.backupPath, this.filePath);
            logState(dim(`💾 State saved (${(json.length / 1024).toFixed(1)}KB)`));
            return true;
        } catch (e) {
            logError(`State save failed: ${e.message}`);
            return false;
        }
    }

    load() {
        try {
            let filePath = this.filePath;
            if (!fs.existsSync(filePath)) {
                if (fs.existsSync(this.backupPath)) {
                    filePath = this.backupPath;
                    logState(yellow('⚠️  Main state file missing, using backup'));
                } else {
                    logState(dim('No saved state found — fresh start'));
                    return null;
                }
            }
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (!data.version || !data.timestamp) {
                logState(yellow('⚠️  Invalid state file format'));
                return null;
            }
            const age = Date.now() - data.timestamp;
            const ageStr = formatDuration(age);
            if (age > 24 * 60 * 60 * 1000) {
                logState(yellow(`⚠️  State file is ${ageStr} old — too stale, starting fresh`));
                return null;
            }
            logState(green(`✅ State loaded (age: ${ageStr}, saved: ${data.timestampStr})`));
            return data;
        } catch (e) {
            logError(`State load failed: ${e.message}`);
            return null;
        }
    }

    startAutoSave(bot, intervalMs) {
        if (this.saveTimer) clearInterval(this.saveTimer);
        this.saveTimer = setInterval(() => {
            if (bot.botState !== BOT_STATE.STOPPED) {
                this.save(bot.getSerializableState());
            }
        }, intervalMs);
    }

    stopAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
    }

    clear() {
        try {
            if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
            if (fs.existsSync(this.backupPath)) fs.unlinkSync(this.backupPath);
        } catch (_) { }
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 1: BAYESIAN ONLINE CHANGEPOINT DETECTION (BOCPD)
// ══════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard = config.bocpd_hazard;
        this.alpha0 = config.bocpd_prior_alpha;
        this.beta0 = config.bocpd_prior_beta;
        this.minRun = config.bocpd_min_run_for_signal;
        this.threshold = config.bocpd_nonrep_confidence;

        this.logR = [0];
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];

        this.t = 0;
        this.lastChangepoint = 0;
        this.runHistory = [];
        this.obsHistory = [];
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }

    update(obs) {
        this.t++;
        this.obsHistory.push(obs);

        const H = this.hazard;
        const lenR = this.logR.length;

        const logPredictive = new Array(lenR);
        for (let r = 0; r < lenR; r++) {
            const theta = this.alphas[r] / (this.alphas[r] + this.betas[r]);
            const p = obs === 1 ? theta : (1 - theta);
            logPredictive[r] = Math.log(Math.max(p, 1e-300));
        }

        const logGrowthMass = logPredictive.map((lp, r) => lp + Math.log(1 - H) + this.logR[r]);
        const logChangepointMass = logSumExp(logPredictive.map((lp, r) => lp + Math.log(H) + this.logR[r]));

        const newLogR = new Array(lenR + 1);
        const newAlphas = new Array(lenR + 1);
        const newBetas = new Array(lenR + 1);

        newLogR[0] = logChangepointMass;
        newAlphas[0] = this.alpha0 + obs;
        newBetas[0] = this.beta0 + (1 - obs);

        for (let r = 0; r < lenR; r++) {
            newLogR[r + 1] = logGrowthMass[r];
            newAlphas[r + 1] = this.alphas[r] + obs;
            newBetas[r + 1] = this.betas[r] + (1 - obs);
        }

        const logZ = logSumExp(newLogR);
        this.logR = newLogR.map(v => v - logZ);
        this.alphas = newAlphas;
        this.betas = newBetas;

        if (this.logR.length > 800) {
            const threshold = Math.max(...this.logR) - 15;
            const keep = this.logR.map((v, i) => i).filter(i => this.logR[i] > threshold);
            if (!keep.includes(0)) keep.unshift(0);
            this.logR = keep.map(i => this.logR[i]);
            this.alphas = keep.map(i => this.alphas[i]);
            this.betas = keep.map(i => this.betas[i]);
            const logZ2 = logSumExp(this.logR);
            this.logR = this.logR.map(v => v - logZ2);
        }

        const probs = this.logR.map(Math.exp);
        this.expectedRunLength = probs.reduce((s, p, r) => s + p * r, 0);
        const modeIdx = this.logR.indexOf(Math.max(...this.logR));
        const thetaMode = this.alphas[modeIdx] / (this.alphas[modeIdx] + this.betas[modeIdx]);
        const pLongRun = probs.slice(this.minRun).reduce((s, p) => s + p, 0);
        const pLowTheta = betaIncomplete(0.15, this.alphas[modeIdx], this.betas[modeIdx]);
        this.pNonRep = clamp(pLongRun * 0.5 + pLowTheta * 0.5, 0, 1);

        this.runHistory.push({ t: this.t, modeRL: modeIdx, theta: thetaMode, pNonRep: this.pNonRep });
        if (this.runHistory.length > 200) this.runHistory.shift();

        return {
            pNonRep: this.pNonRep,
            expectedRL: this.expectedRunLength,
            modeRL: modeIdx,
            thetaEstimate: thetaMode,
            pLongRun,
            pLowTheta,
            pChangepoint: Math.exp(this.logR[0]),
        };
    }

    isNonRepRegime() {
        return this.pNonRep >= this.threshold && this.expectedRunLength >= this.minRun;
    }

    reset() {
        this.logR = [0];
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];
        this.t = 0;
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 2: 2-STATE BINARY HMM
// ══════════════════════════════════════════════════════════════════════════════
class BinaryHMM {
    constructor(config) {
        this.cfg = config;
        this.MIN_DISCRIM = config.hmm_min_discrimination || 0.10;
        this.pi = [0.65, 0.35];
        this.A = [[0.93, 0.07], [0.22, 0.78]];
        this.B = [[0.91, 0.09], [0.55, 0.45]];
        this.logAlpha = [Math.log(0.65), Math.log(0.35)];
        this.fitted = false;
        this.lastFitDiscrim = 0;
    }

    buildObs(digitSeq) {
        const obs = new Array(digitSeq.length - 1);
        for (let t = 1; t < digitSeq.length; t++) {
            obs[t - 1] = digitSeq[t] === digitSeq[t - 1] ? 1 : 0;
        }
        return obs;
    }

    baumWelch(obs, maxIter = 30, tol = 1e-6) {
        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };

        let pi = [...this.pi];
        let A = this.A.map(r => [...r]);
        let B = this.B.map(r => [...r]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            const logAlpha = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    const inc = [0, 1].map(p => logAlpha[t - 1][p] + Math.log(A[p][s] + 1e-300));
                    logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }
            const logL = logSumExp(logAlpha[T - 1]);

            const logBeta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T - 1][s] = 0;
            for (let t = T - 2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    const vals = [0, 1].map(nx => Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx]);
                    logBeta[t][s] = logSumExp(vals);
                }
            }

            const logGamma = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - d;
            }

            const logXi = Array.from({ length: T - 1 }, () => Array.from({ length: N }, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T - 1; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) for (let nx = 0; nx < N; nx++) {
                    logXi[t][s][nx] = logAlpha[t][s] + Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx] - d;
                }
            }

            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi.reduce((a, b) => a + b, 0);
            pi = pi.map(v => v / piSum);

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0, T - 1).map(g => g[s]));
                for (let nx = 0; nx < N; nx++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][nx]));
                    A[s][nx] = Math.exp(numer - denom);
                }
                const rs = A[s].reduce((a, b) => a + b, 0);
                A[s] = A[s].map(v => v / rs);
            }

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < O; o++) {
                    const relevant = logGamma.filter((_, t) => obs[t] === o).map(g => g[s]);
                    B[s][o] = relevant.length > 0 ? Math.exp(logSumExp(relevant) - denom) : 1e-10;
                }
                const bsum = B[s].reduce((a, b) => a + b, 0);
                B[s] = B[s].map(v => v / bsum);
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        if (B[0][1] > B[1][1]) {
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        const discrimination = B[1][1] - B[0][1];
        if (discrimination < this.MIN_DISCRIM) {
            return {
                accepted: false, discrimination, repeatNR: B[0][1], repeatREP: B[1][1],
                reason: `discrimination ${(discrimination * 100).toFixed(1)}% < ${(this.MIN_DISCRIM * 100).toFixed(0)}% threshold`
            };
        }

        this.pi = pi; this.A = A; this.B = B;
        this.fitted = true;
        this.lastFitDiscrim = discrimination;
        return { accepted: true, discrimination, repeatNR: B[0][1], repeatREP: B[1][1] };
    }

    viterbi(obs) {
        const T = obs.length, N = 2;
        if (T === 0) return null;
        const logDelta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
        const psi = Array.from({ length: T }, () => new Array(N).fill(0));
        for (let s = 0; s < N; s++) logDelta[0][s] = Math.log(this.pi[s] + 1e-300) + Math.log(this.B[s][obs[0]] + 1e-300);
        for (let t = 1; t < T; t++) {
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bp = 0;
                for (let p = 0; p < N; p++) {
                    const v = logDelta[t - 1][p] + Math.log(this.A[p][s] + 1e-300);
                    if (v > best) { best = v; bp = p; }
                }
                logDelta[t][s] = best + Math.log(this.B[s][obs[t]] + 1e-300);
                psi[t][s] = bp;
            }
        }
        const seq = new Array(T);
        seq[T - 1] = logDelta[T - 1][0] >= logDelta[T - 1][1] ? 0 : 1;
        for (let t = T - 2; t >= 0; t--) seq[t] = psi[t + 1][seq[t + 1]];

        const cur = seq[T - 1];
        let persistence = 1;
        for (let t = T - 2; t >= 0; t--) { if (seq[t] === cur) persistence++; else break; }
        let transitions = 0;
        for (let t = 1; t < T; t++) if (seq[t] !== seq[t - 1]) transitions++;
        const seg = Math.max(1, Math.floor(T / 5));
        const segFracs = [];
        for (let i = 0; i < 5 && i * seg < T; i++) {
            const sl = seq.slice(i * seg, Math.min((i + 1) * seg, T));
            segFracs.push(sl.filter(s => s === 0).length / sl.length);
        }
        const stability = segFracs.reduce((a, b) => a + b, 0) / segFracs.length;

        return { stateSeq: seq, currentState: cur, persistence, transitions, stability };
    }

    updateForward(obs_t) {
        const N = 2;
        const newLogA = new Array(N);
        for (let s = 0; s < N; s++) {
            const inc = this.logAlpha.map((la, p) => la + Math.log(this.A[p][s] + 1e-300));
            newLogA[s] = logSumExp(inc) + Math.log(this.B[s][obs_t] + 1e-300);
        }
        this.logAlpha = newLogA;
        const d = logSumExp(newLogA);
        return [Math.exp(newLogA[0] - d), Math.exp(newLogA[1] - d)];
    }

    repeatEmission(state) { return this.B[state][1]; }
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 3: MULTI-SCALE EWMA STACK
// ══════════════════════════════════════════════════════════════════════════════
class EWMAStack {
    constructor() {
        this.lambdas = [0.40, 0.18, 0.07, 0.025];
        this.names = ['ultra-short(~4t)', 'short(~15t)', 'medium(~40t)', 'long(~100t)'];
        this.values = [null, null, null, null];
        this.n = 0;
    }

    update(repeatObs) {
        const v = repeatObs * 100;
        this.n++;
        for (let i = 0; i < 4; i++) {
            if (this.values[i] === null) this.values[i] = v;
            else this.values[i] = this.lambdas[i] * v + (1 - this.lambdas[i]) * this.values[i];
        }
    }

    get(idx) { return this.values[idx] ?? 50; }
    trend() { return this.get(1) - this.get(3); }
    allBelowThreshold(threshold) { return this.values.every(v => v === null || v < threshold); }
    summary() { return this.names.map((n, i) => `${n}=${this.get(i).toFixed(1)}%`).join(' | '); }
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 4: LAG AUTOCORRELATION
// ══════════════════════════════════════════════════════════════════════════════
function computeACF(seq, maxLag = 5) {
    const n = seq.length;
    if (n < maxLag + 2) return new Array(maxLag).fill(0);
    const mean = seq.reduce((s, v) => s + v, 0) / n;
    const variance = seq.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    if (variance < 1e-10) return new Array(maxLag).fill(0);
    const acf = [];
    for (let lag = 1; lag <= maxLag; lag++) {
        let cov = 0;
        for (let t = 0; t < n - lag; t++) cov += (seq[t] - mean) * (seq[t + lag] - mean);
        acf.push(cov / ((n - lag) * variance));
    }
    return acf;
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 5: STRUCTURAL BREAK DETECTOR
// ══════════════════════════════════════════════════════════════════════════════
function structuralBreakTest(repeatSeq) {
    const n = repeatSeq.length;
    if (n < 20) return { lrtStat: 0, pBreak: 0, rateOld: 0.1, rateNew: 0.1 };
    const half = Math.floor(n / 2);
    const oldHalf = repeatSeq.slice(0, half);
    const newHalf = repeatSeq.slice(half);
    const k1 = oldHalf.reduce((s, v) => s + v, 0);
    const k2 = newHalf.reduce((s, v) => s + v, 0);
    const n1 = oldHalf.length, n2 = newHalf.length;
    const p1 = k1 / n1, p2 = k2 / n2;
    const pPool = (k1 + k2) / (n1 + n2);

    function logLik(k, n, p) {
        if (p <= 0 || p >= 1) return 0;
        return k * Math.log(p) + (n - k) * Math.log(1 - p);
    }
    const llAlt = logLik(k1, n1, p1) + logLik(k2, n2, p2);
    const llNull = logLik(k1 + k2, n1 + n2, pPool);
    const lrtStat = 2 * (llAlt - llNull);
    const chi2cdf = lrtStat <= 0 ? 0 : Math.min(0.9999,
        1 - Math.exp(-0.5 * Math.pow(Math.max(0, lrtStat), 1) * 0.5));
    const pBreak = p2 > p1 ? chi2cdf : 0;
    return { lrtStat: Math.max(0, lrtStat), pBreak, rateOld: p1, rateNew: p2 };
}


// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 6: TWO-SIDED CUSUM
// ══════════════════════════════════════════════════════════════════════════════
class TwoSidedCUSUM {
    constructor(config) {
        this.slack = config.cusum_slack;
        this.upThr = config.cusum_up_threshold;
        this.downThr = config.cusum_down_threshold;
        this.upC = new Array(10).fill(0);
        this.downC = new Array(10).fill(0);
        this.globalUp = 0;
        this.globalDown = 0;
    }

    update(digit, isRepeat, p0 = 0.10, p1 = 0.40) {
        const logLR = Math.log((isRepeat ? p1 : (1 - p1)) / ((isRepeat ? p0 : (1 - p0)) + 1e-300) + 1e-300);
        this.upC[digit] = Math.max(0, this.upC[digit] + logLR - this.slack);
        this.downC[digit] = Math.min(0, this.downC[digit] + logLR + this.slack);
        this.globalUp = Math.max(0, this.globalUp + logLR - this.slack);
        this.globalDown = Math.min(0, this.globalDown + logLR + this.slack);
    }

    resetDigit(d) { this.upC[d] = 0; this.downC[d] = 0; }
    resetGlobal() { this.globalUp = 0; this.globalDown = 0; }
    upAlarm(digit) { return this.upC[digit] > this.upThr || this.globalUp > this.upThr; }
    downConfirmed(digit) { return this.downC[digit] < this.downThr && this.globalDown < this.downThr; }

    summary(digit) {
        return `up=${this.upC[digit].toFixed(2)}(${this.upAlarm(digit) ? 'ALARM' : 'ok'}) ` +
            `down=${this.downC[digit].toFixed(2)}(${this.downConfirmed(digit) ? 'confirmed' : 'pending'}) ` +
            `globalUp=${this.globalUp.toFixed(2)} globalDown=${this.globalDown.toFixed(2)}`;
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  MAIN REGIME DETECTOR: ENSEMBLE OF ALL COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════
class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.bocpd = new BOCPD(config);
        this.hmm = new BinaryHMM(config);
        this.ewma = new EWMAStack();
        this.cusum = new TwoSidedCUSUM(config);
        this.perDigitRate = new Array(10).fill(10);
        this.repeatBuffer = [];
        this.BUFFER_MAX = 500;
        this.weights = { bocpd: 1.0, hmm: 1.0, ewma: 1.0, acf: 0.7, structural: 0.6, cusum: 1.0 };
        this.ticksSinceRefit = 0;
        this.hmmResult = null;
        this.bocpdResult = null;
    }

    computePerDigitRepeatRate(window) {
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);
        for (let i = 0; i < window.length - 1; i++) {
            transFrom[window[i]]++;
            if (window[i + 1] === window[i]) transRepeat[window[i]]++;
        }
        return transFrom.map((n, d) => n > 0 ? (transRepeat[d] / n) * 100 : 10);
    }

    tick(prevDigit, curDigit) {
        const isRepeat = prevDigit === curDigit;
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
        const len = window.length;

        if (len < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: `insufficient data (${len}/${this.cfg.min_ticks_for_analysis})` };
        }

        const binaryObs = this.hmm.buildObs(window);

        if (!this.hmm.fitted || this.ticksSinceRefit >= this.cfg.hmm_refit_every) {
            const fitResult = this.hmm.baumWelch(binaryObs);
            this.ticksSinceRefit = 0;
        }

        const vit = this.hmm.viterbi(binaryObs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        let logA = [Math.log(this.hmm.pi[0] + 1e-300), Math.log(this.hmm.pi[1] + 1e-300)];
        logA[0] += Math.log(this.hmm.B[0][binaryObs[0]] + 1e-300);
        logA[1] += Math.log(this.hmm.B[1][binaryObs[0]] + 1e-300);
        for (let t = 1; t < binaryObs.length; t++) {
            const nA = [0, 1].map(s => {
                const inc = [0, 1].map(p => logA[p] + Math.log(this.hmm.A[p][s] + 1e-300));
                return logSumExp(inc) + Math.log(this.hmm.B[s][binaryObs[t]] + 1e-300);
            });
            logA = nA;
        }
        const denom = logSumExp(logA);
        const posteriorNR = Math.exp(logA[0] - denom);
        const posteriorRep = Math.exp(logA[1] - denom);

        const rawRepeatProb = this.computePerDigitRepeatRate(window);

        const shortWin = window.slice(-20);
        const shortRepeats = shortWin.slice(1).filter((d, i) => d === shortWin[i]).length;
        const recentRate = (shortRepeats / (shortWin.length - 1)) * 100;

        const acfWindow = this.repeatBuffer.slice(-Math.min(this.repeatBuffer.length, 200));
        const acf = computeACF(acfWindow, 5);

        const breakBuf = this.repeatBuffer.slice(-100);
        const breakResult = structuralBreakTest(breakBuf);

        const bocpd = this.bocpdResult || { pNonRep: 0.5, expectedRL: 0, modeRL: 0, thetaEstimate: 0.1, pChangepoint: 0.5 };

        const ewmaValues = [0, 1, 2, 3].map(i => this.ewma.get(i));
        const ewmaTrend = this.ewma.trend();

        const cusumUpAlarm = this.cusum.upAlarm(targetDigit);
        const cusumDownConfirm = this.cusum.downConfirmed(targetDigit);

        // ── Ensemble Scoring ──────────────────────────────────────────────────
        const threshold = this.cfg.repeat_threshold;
        const w = this.weights;

        const bocpdScore = (() => {
            if (!this.bocpd.isNonRepRegime()) return 0;
            const rl = Math.min(bocpd.modeRL, 150) / 150;
            return rl * 25 * w.bocpd;
        })();

        const hmmScore = (() => {
            if (vit.currentState !== 0) return 0;
            const persist = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
            const stability = vit.stability;
            const posterior = clamp((posteriorNR - 0.5) / 0.5, 0, 1);
            return ((persist * 0.4 + stability * 0.3 + posterior * 0.3) * 25) * w.hmm;
        })();

        const ewmaScore = (() => {
            const allBelow = ewmaValues.every(v => v < threshold);
            if (!allBelow) return 0;
            const trendOk = ewmaTrend <= this.cfg.ewma_trend_threshold;
            const score = allBelow && trendOk ? 1.0 : 0.5;
            const margin = Math.min(...ewmaValues.map(v => Math.max(0, threshold - v))) / threshold;
            return (score * 0.7 + margin * 0.3) * 20 * w.ewma;
        })();

        const acfScore = (() => {
            const lag1 = acf[0] ?? 0;
            if (lag1 >= this.cfg.acf_lag1_threshold) return 0;
            const score = clamp(1 - lag1 / this.cfg.acf_lag1_threshold, 0, 1);
            const bonus = lag1 < 0 ? 0.1 : 0;
            return Math.min(1, score + bonus) * 15 * w.acf;
        })();

        const breakScore = (() => {
            if (breakResult.pBreak > this.cfg.structural_break_threshold) return 0;
            return (1 - breakResult.pBreak / this.cfg.structural_break_threshold) * 10 * w.structural;
        })();

        const cusumScore = (() => {
            if (cusumUpAlarm) return 0;
            const base = 3;
            const bonus = cusumDownConfirm ? 2 : 0;
            return (base + bonus) * w.cusum;
        })();

        let rawScore = bocpdScore + hmmScore + ewmaScore + acfScore + breakScore + cusumScore;

        if (vit.currentState !== 0) rawScore = 0;
        if (posteriorNR < this.cfg.hmm_nonrep_confidence) rawScore = Math.min(rawScore, 30);
        if (rawRepeatProb[targetDigit] >= threshold) rawScore = 0;
        if (this.ewma.get(0) >= threshold || this.ewma.get(1) >= threshold) rawScore = 0;
        if (cusumUpAlarm) rawScore = 0;
        if (bocpd.pChangepoint > 0.3) rawScore = Math.min(rawScore, 25);
        if (ewmaTrend > this.cfg.ewma_trend_threshold * 2) rawScore = 0;

        const safetyScore = Math.round(clamp(rawScore, 0, 100));

        const signalActive = (
            vit.currentState === 0 &&
            posteriorNR >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            this.bocpd.isNonRepRegime() &&
            bocpd.pNonRep >= this.cfg.bocpd_nonrep_confidence &&
            bocpd.modeRL >= this.cfg.bocpd_min_run_for_signal &&
            rawRepeatProb[targetDigit] < threshold &&
            this.ewma.get(0) < threshold && this.ewma.get(1) < threshold &&
            ewmaTrend <= this.cfg.ewma_trend_threshold &&
            (acf[0] ?? 0) < this.cfg.acf_lag1_threshold &&
            !cusumUpAlarm &&
            breakResult.pBreak < this.cfg.structural_break_threshold &&
            safetyScore >= this.cfg.repeat_confidence
        );

        return {
            valid: true,
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            hmmStability: vit.stability,
            posteriorNR, posteriorRep,
            hmmA: this.hmm.A,
            hmmB_repeatNR: this.hmm.repeatEmission(0),
            hmmB_repeatREP: this.hmm.repeatEmission(1),
            hmmDiscrim: this.hmm.lastFitDiscrim,
            bocpdPNonRep: bocpd.pNonRep,
            bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL,
            bocpdTheta: bocpd.thetaEstimate,
            bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(),
            ewmaValues, ewmaTrend,
            acf,
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

    applyTradeFeedback(won, regime) {
        if (!regime || !regime.valid) return;
        const decay = 0.85, restore = 1.02;
        if (!won) {
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.max(0.5, this.weights[key] * decay);
        } else {
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.min(1.0, this.weights[key] * restore);
        }
    }

    resetCUSUM(digit) { this.cusum.resetDigit(digit); }
}


// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-ASSET BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════
class MultiAssetGhostBot {
    constructor(config) {
        this.config = config;

        this.ws = null;
        this.botState = BOT_STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT = 10;
        this.pingInterval = null;
        this.requestId = 0;

        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';

        // ── Multi-Asset State ─────────────────────────────────────────────────
        this.tickHistories = {};       // { symbol: [digit, digit, ...] }
        this.prevDigits = {};          // { symbol: lastDigit }
        this.detectors = {};           // { symbol: AdvancedRegimeDetector }
        this.regimes = {};             // { symbol: latest regime analysis }
        this.assetScores = {};         // { symbol: latest safety score }
        this.assetTickCounts = {};     // { symbol: total ticks received }
        this.assetsReady = {};         // { symbol: true/false — has enough history }
        this.ticksSinceAssetSwitch = 0;
        this.assetScanCounter = 0;

        // Initialize per-asset state
        for (const sym of config.symbols) {
            this.tickHistories[sym] = [];
            this.prevDigits[sym] = -1;
            this.detectors[sym] = new AdvancedRegimeDetector(config);
            this.regimes[sym] = null;
            this.assetScores[sym] = 0;
            this.assetTickCounts[sym] = 0;
            this.assetsReady[sym] = false;
        }

        // Active trading state
        this.activeAsset = null;       // Currently selected asset for trading
        this.regime = null;
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;
        this.lastTradeAsset = null;    // Asset of the last placed trade

        // Ghost state
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;

        // Trading
        this.currentStake = config.base_stake;
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.isTradeActive = false;
        this.lastBuyPrice = 0;
        this.lastContractId = null;
        this.pendingTrade = false;

        // Stats
        this.sessionStartTime = Date.now();
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.sessionProfit = 0;
        this.currentWinStreak = 0;
        this.currentLossStreak = 0;
        this.maxWinStreak = 0;
        this.maxLossStreak = 0;
        this.maxMartingaleReached = 0;
        this.largestWin = 0;
        this.largestLoss = 0;
        this.perAssetStats = {};
        for (const sym of config.symbols) {
            this.perAssetStats[sym] = { trades: 0, wins: 0, losses: 0, profit: 0 };
        }

        this.cooldownTimer = null;
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // State persistence
        this.persistence = new StatePersistence(config.state_file);

        // Track which historical data loads are pending
        this.pendingHistoryLoads = new Set(config.symbols);
    }

    // ── State Serialization ───────────────────────────────────────────────────
    getSerializableState() {
        return {
            // Trading state
            activeAsset: this.activeAsset,
            lastTradeAsset: this.lastTradeAsset,
            targetDigit: this.targetDigit,
            martingaleStep: this.martingaleStep,
            totalMartingaleLoss: this.totalMartingaleLoss,
            currentStake: this.currentStake,

            // Stats
            sessionStartTime: this.sessionStartTime,
            totalTrades: this.totalTrades,
            totalWins: this.totalWins,
            totalLosses: this.totalLosses,
            sessionProfit: this.sessionProfit,
            currentWinStreak: this.currentWinStreak,
            currentLossStreak: this.currentLossStreak,
            maxWinStreak: this.maxWinStreak,
            maxLossStreak: this.maxLossStreak,
            maxMartingaleReached: this.maxMartingaleReached,
            largestWin: this.largestWin,
            largestLoss: this.largestLoss,
            perAssetStats: this.perAssetStats,

            // Account
            accountBalance: this.accountBalance,
            startingBalance: this.startingBalance,
            accountId: this.accountId,

            // Per-asset tick histories (last 200 per asset to keep file small)
            tickHistories: Object.fromEntries(
                Object.entries(this.tickHistories).map(([sym, hist]) => [sym, hist.slice(-200)])
            ),

            // Ghost state
            ghostConsecutiveWins: this.ghostConsecutiveWins,
            ghostRoundsPlayed: this.ghostRoundsPlayed,
            ghostConfirmed: this.ghostConfirmed,

            // Bot state
            botState: this.botState,
        };
    }

    restoreFromState(saved) {
        if (!saved) return false;
        try {
            logState(cyan('🔄 Restoring state from persistence...'));

            // Restore stats
            if (saved.sessionStartTime) this.sessionStartTime = saved.sessionStartTime;
            if (saved.totalTrades !== undefined) this.totalTrades = saved.totalTrades;
            if (saved.totalWins !== undefined) this.totalWins = saved.totalWins;
            if (saved.totalLosses !== undefined) this.totalLosses = saved.totalLosses;
            if (saved.sessionProfit !== undefined) this.sessionProfit = saved.sessionProfit;
            if (saved.currentWinStreak !== undefined) this.currentWinStreak = saved.currentWinStreak;
            if (saved.currentLossStreak !== undefined) this.currentLossStreak = saved.currentLossStreak;
            if (saved.maxWinStreak !== undefined) this.maxWinStreak = saved.maxWinStreak;
            if (saved.maxLossStreak !== undefined) this.maxLossStreak = saved.maxLossStreak;
            if (saved.maxMartingaleReached !== undefined) this.maxMartingaleReached = saved.maxMartingaleReached;
            if (saved.largestWin !== undefined) this.largestWin = saved.largestWin;
            if (saved.largestLoss !== undefined) this.largestLoss = saved.largestLoss;
            if (saved.perAssetStats) this.perAssetStats = { ...this.perAssetStats, ...saved.perAssetStats };

            // Restore trading state
            if (saved.activeAsset) this.activeAsset = saved.activeAsset;
            if (saved.lastTradeAsset) this.lastTradeAsset = saved.lastTradeAsset;
            if (saved.targetDigit !== undefined) this.targetDigit = saved.targetDigit;
            if (saved.martingaleStep !== undefined) this.martingaleStep = saved.martingaleStep;
            if (saved.totalMartingaleLoss !== undefined) this.totalMartingaleLoss = saved.totalMartingaleLoss;
            if (saved.currentStake !== undefined) this.currentStake = saved.currentStake;
            if (saved.startingBalance !== undefined) this.startingBalance = saved.startingBalance;

            // Restore ghost state
            if (saved.ghostConsecutiveWins !== undefined) this.ghostConsecutiveWins = saved.ghostConsecutiveWins;
            if (saved.ghostRoundsPlayed !== undefined) this.ghostRoundsPlayed = saved.ghostRoundsPlayed;
            if (saved.ghostConfirmed !== undefined) this.ghostConfirmed = saved.ghostConfirmed;

            logState(green(`✅ State restored | Trades:${this.totalTrades} W:${this.totalWins} L:${this.totalLosses} P&L:${formatMoney(this.sessionProfit)} Mart:${this.martingaleStep}`));

            this.sendTelegram(`🔄 <b>STATE RESTORED</b>\n\n` +
                `📊 Trades: ${this.totalTrades} | ${this.totalWins}W/${this.totalLosses}L\n` +
                `💰 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
                `🔧 Martingale Step: ${this.martingaleStep}\n` +
                `📊 Active Asset: ${this.activeAsset || 'scanning...'}\n` +
                `⏱ ${new Date().toLocaleString()}`);

            return true;
        } catch (e) {
            logError(`State restore error: ${e.message}`);
            return false;
        }
    }

    start() {
        this.printBanner();

        // Try to restore state
        const saved = this.persistence.load();
        if (saved) {
            this.restoreFromState(saved);
        }

        this.connectWS();
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v4.0  —  Multi-Asset Regime Detection    ')));
        console.log(bold(cyan('   BOCPD + HMM + EWMA + ACF + Break + CUSUM × Multi-Asset          ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(`  Assets              : ${bold(c.symbols.join(', '))}`);
        console.log(`  Total Assets        : ${bold(c.symbols.length)}`);
        console.log(`  Asset Scan Interval : Every ${bold(c.asset_scan_interval)} ticks`);
        console.log(`  Min Score Advantage : ${bold(c.min_score_advantage)} pts to switch`);
        console.log(`  Asset Lock Period   : ${bold(c.asset_lock_ticks)} ticks min`);
        console.log(`  Base Stake          : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window     : ${bold(c.analysis_window)} ticks`);
        console.log(`  Repeat Threshold    : ${bold(c.repeat_threshold + '%')}`);
        console.log(`  Ensemble Confidence : ${bold(c.repeat_confidence + '/100')}`);
        console.log(`  Ghost Trading       : ${c.ghost_enabled ? green('ON') + ` | Wins: ${c.ghost_wins_required}` : red('OFF')}`);
        console.log(`  Martingale          : ${c.martingale_enabled ? green('ON') + ` | Steps: ${c.max_martingale_steps} | Mult: ${c.martingale_multiplier}x` : red('OFF')}`);
        console.log(`  Take Profit         : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss           : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(`  State Persistence   : ${green('ON')} | File: ${dim(c.state_file)}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log('');
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connectWS() {
        this.botState = BOT_STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);
        try { this.ws = new WebSocket(url); } catch (e) { logError(`WS create failed: ${e.message}`); this.attemptReconnect(); return; }

        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = BOT_STATE.AUTHENTICATING;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
            }, 30000);
            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            try { this.handleMessage(JSON.parse(raw)); }
            catch (e) { logError(`Parse: ${e.message}`); }
        });

        this.ws.on('close', code => {
            logApi(`⚠️  Closed (${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== BOT_STATE.STOPPED) {
                // Save state before reconnecting
                this.persistence.save(this.getSerializableState());
                this.attemptReconnect();
            }
        });

        this.ws.on('error', e => logError(`WS error: ${e.message}`));
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) { this.stop('Max reconnects'); return; }
        this.reconnectAttempts++;
        const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 30000);
        logApi(`Reconnect in ${delay / 1000}s (${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
        this.isTradeActive = false;

        this.sendTelegram(`⚠️ <b>RECONNECTING</b>\n\n` +
            `🔄 Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT}\n` +
            `⏱ Delay: ${delay / 1000}s\n` +
            `💰 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
            `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L`);

        setTimeout(() => { if (this.botState !== BOT_STATE.STOPPED) this.connectWS(); }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); } catch (e) { logError(`Send: ${e.message}`); }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }).catch(() => { });
    }

    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize': this.handleAuth(msg); break;
            case 'balance': this.handleBalance(msg); break;
            case 'history': this.handleTickHistory(msg); break;
            case 'tick': this.handleTick(msg); break;
            case 'buy': this.handleBuy(msg); break;
            case 'transaction': this.handleTransaction(msg); break;
            case 'ping': break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN', emsg = msg.error.message || 'Unknown';
        logError(`[${code}] on ${msg.msg_type || '?'}: ${emsg}`);
        if (['InvalidToken', 'AuthorizationRequired'].includes(code)) { this.stop('Auth failed'); return; }
        if (code === 'RateLimit') {
            setTimeout(() => {
                if (this.botState !== BOT_STATE.STOPPED) { this.isTradeActive = false; this.executeTradeFlow(false); }
            }, 10000);
        }
        if (code === 'InsufficientBalance') { this.stop('Insufficient balance'); return; }
        if (msg.msg_type === 'buy') { this.isTradeActive = false; this.botState = BOT_STATE.ANALYZING; }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        if (!this.startingBalance || this.startingBalance === 0) this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        if (!this.sessionStartTime) this.sessionStartTime = Date.now();
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Authenticated')} | ${bold(this.accountId)} ${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | Balance: ${green('$' + this.accountBalance.toFixed(2))}`);
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT — trading with real money!');

        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });

        // Fetch history for all assets
        this.botState = BOT_STATE.COLLECTING_TICKS;
        this.pendingHistoryLoads = new Set(this.config.symbols);

        for (const sym of this.config.symbols) {
            logBot(`Fetching ${bold(this.config.tick_history_size)} ticks for ${bold(sym)}...`);
            this.send({
                ticks_history: sym,
                count: this.config.tick_history_size,
                end: 'latest',
                style: 'ticks',
                req_id: this.requestId,
            });
        }

        // Start state auto-save
        this.persistence.startAutoSave(this, this.config.state_save_interval);
    }

    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) return;

        // Identify which symbol this history belongs to
        const echo = msg.echo_req;
        const sym = echo ? echo.ticks_history : null;
        if (!sym || !this.config.symbols.includes(sym)) {
            logError(`Received history for unknown symbol`);
            return;
        }

        const digits = msg.history.prices.map(p => getLastDigit(p, sym));
        this.tickHistories[sym] = digits.slice(-this.config.tick_history_size);
        this.prevDigits[sym] = digits.length > 0 ? digits[digits.length - 1] : -1;
        this.assetTickCounts[sym] = this.tickHistories[sym].length;

        logBot(`${green('✅')} Loaded ${bold(this.tickHistories[sym].length)} ticks for ${bold(sym)}`);

        // Warm up detector
        const hist = this.tickHistories[sym];
        for (let i = 1; i < hist.length; i++) {
            this.detectors[sym].tick(hist[i - 1], hist[i]);
        }
        logBot(green(`✅ Detector warmed for ${sym}`));

        this.assetsReady[sym] = hist.length >= this.config.min_ticks_for_analysis;
        this.pendingHistoryLoads.delete(sym);

        // Subscribe to live ticks for this symbol
        this.send({ ticks: sym, subscribe: 1 });

        // Check if all done
        if (this.pendingHistoryLoads.size === 0) {
            const readyCount = Object.values(this.assetsReady).filter(v => v).length;
            logBot(green(bold(`✅ All ${this.config.symbols.length} assets loaded! (${readyCount} ready for analysis)`)));
            this.botState = BOT_STATE.ANALYZING;

            // Initial scan for best asset
            this.scanAllAssets();

            this.sendTelegram(`🚀 <b>BOT STARTED — Multi-Asset v4.0</b>\n\n` +
                `📊 Assets: ${this.config.symbols.length}\n` +
                `${this.config.symbols.map(s => `  • ${s}: ${this.assetsReady[s] ? '✅' : '⏳'} (${this.tickHistories[s].length} ticks)`).join('\n')}\n\n` +
                `💰 Balance: $${this.accountBalance.toFixed(2)}\n` +
                `🎯 Active: ${this.activeAsset || 'scanning...'}\n` +
                `⏱ ${new Date().toLocaleString()}`);
        }
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    handleTick(msg) {
        if (!msg.tick || this.botState === BOT_STATE.STOPPED) return;

        const sym = msg.tick.symbol;
        if (!this.config.symbols.includes(sym)) return;

        const price = msg.tick.quote;
        const curDigit = getLastDigit(price, sym);
        const prevDigit = this.prevDigits[sym];

        this.tickHistories[sym].push(curDigit);
        if (this.tickHistories[sym].length > this.config.tick_history_size) {
            this.tickHistories[sym] = this.tickHistories[sym].slice(-this.config.tick_history_size);
        }
        this.assetTickCounts[sym] = (this.assetTickCounts[sym] || 0) + 1;

        // Update detector incrementally
        if (prevDigit >= 0) {
            this.detectors[sym].tick(prevDigit, curDigit);
        }
        this.prevDigits[sym] = curDigit;

        // Check if this asset is now ready
        if (!this.assetsReady[sym] && this.tickHistories[sym].length >= this.config.min_ticks_for_analysis) {
            this.assetsReady[sym] = true;
            logAsset(green(`✅ ${sym} now has enough ticks for analysis`));
        }

        // ── Logging for active asset ─────────────────────────────────────────
        if (sym === this.activeAsset) {
            const count = this.tickHistories[sym].length;
            const last5 = this.tickHistories[sym].slice(Math.max(0, count - 6), count - 1);
            const stateHint =
                this.botState === BOT_STATE.WAITING_RESULT ? '⏳ waiting'
                    : this.botState === BOT_STATE.COOLDOWN ? '❄️ cooldown'
                        : this.botState === BOT_STATE.GHOST_TRADING ? `👻 ghost ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
                            : '';
            logTick(
                dim(`[${sym}] `) + dim(last5.join(' › ') + '  ›') + ` ${bold(cyan('[' + curDigit + ']'))}` +
                dim(`  ${price}  (${count})`) +
                (stateHint ? `  ${dim(stateHint)}` : '')
            );
        }

        // ── Periodic asset scan ──────────────────────────────────────────────
        if (sym === this.config.symbols[0]) { // Use first symbol as clock
            this.assetScanCounter++;
            this.ticksSinceAssetSwitch++;
            if (this.assetScanCounter >= this.config.asset_scan_interval) {
                this.assetScanCounter = 0;
                if (this.botState === BOT_STATE.ANALYZING && !this.isTradeActive) {
                    this.scanAllAssets();
                }
            }
        }

        // ── Pending trade gate ───────────────────────────────────────────────
        if (this.pendingTrade && !this.isTradeActive && this.botState !== BOT_STATE.STOPPED && sym === this.activeAsset) {
            if (curDigit === this.targetDigit) {
                this.pendingTrade = false;
                this.placeTrade();
                return;
            }
            logGhost(dim(`⏳ [${sym}] Waiting for digit ${bold(this.targetDigit)} — got ${curDigit}`));
            return;
        }

        // ── State machine for active asset ───────────────────────────────────
        if (sym === this.activeAsset) {
            switch (this.botState) {
                case BOT_STATE.ANALYZING:
                    if (this.assetsReady[sym]) {
                        this.regimes[sym] = this.detectors[sym].analyze(this.tickHistories[sym], curDigit);
                        this.regime = this.regimes[sym];
                        this.applyRegimeSignal(curDigit, sym);
                        this.logRegimeAnalysis(curDigit, sym);
                        if (this.signalActive) this.processSignal(curDigit);
                    }
                    break;

                case BOT_STATE.GHOST_TRADING:
                    if (this.assetsReady[sym]) {
                        this.regimes[sym] = this.detectors[sym].analyze(this.tickHistories[sym], this.targetDigit);
                        this.regime = this.regimes[sym];
                        this.refreshSignalForLockedTarget(sym);
                        this.runGhostCheck(curDigit);
                    }
                    break;

                case BOT_STATE.WAITING_RESULT:
                case BOT_STATE.COOLDOWN:
                    if (this.assetsReady[sym]) {
                        this.regimes[sym] = this.detectors[sym].analyze(this.tickHistories[sym], curDigit);
                    }
                    break;
            }
        }
    }

    // ── Multi-Asset Scanning ─────────────────────────────────────────────────
    scanAllAssets() {
        const scores = {};
        let bestAsset = null;
        let bestScore = -1;
        let bestDigit = -1;

        for (const sym of this.config.symbols) {
            if (!this.assetsReady[sym]) continue;

            const hist = this.tickHistories[sym];
            const lastDigit = hist[hist.length - 1];

            // Run analysis for each digit and find the best one
            let bestDigitScore = -1;
            let bestDigitForAsset = -1;

            for (let d = 0; d < 10; d++) {
                const regime = this.detectors[sym].analyze(hist, d);
                if (regime && regime.valid && regime.safetyScore > bestDigitScore) {
                    bestDigitScore = regime.safetyScore;
                    bestDigitForAsset = d;
                }
            }

            // Also check the current last digit
            const currentRegime = this.detectors[sym].analyze(hist, lastDigit);
            if (currentRegime && currentRegime.valid && currentRegime.safetyScore > bestDigitScore) {
                bestDigitScore = currentRegime.safetyScore;
                bestDigitForAsset = lastDigit;
            }

            scores[sym] = bestDigitScore;
            this.assetScores[sym] = bestDigitScore;
            this.regimes[sym] = this.detectors[sym].analyze(hist, bestDigitForAsset >= 0 ? bestDigitForAsset : lastDigit);

            if (bestDigitScore > bestScore) {
                bestScore = bestDigitScore;
                bestAsset = sym;
                bestDigit = bestDigitForAsset;
            }
        }

        // Log asset scan summary
        const scoreStr = Object.entries(scores)
            .sort((a, b) => b[1] - a[1])
            .map(([sym, score]) => {
                const active = sym === this.activeAsset ? '▶' : ' ';
                const best = sym === bestAsset ? '★' : ' ';
                const col_fn = score >= this.config.repeat_confidence ? green : (score >= 50 ? yellow : red);
                return `${active}${best}${col_fn(`${sym}:${score}`)}`;
            })
            .join(' | ');

        logAsset(`📊 Asset Scan: [${scoreStr}]`);

        // Decide whether to switch
        const currentScore = this.activeAsset ? (scores[this.activeAsset] || 0) : 0;
        const advantage = bestScore - currentScore;

        if (!this.activeAsset || (advantage >= this.config.min_score_advantage && this.ticksSinceAssetSwitch >= this.config.asset_lock_ticks) || currentScore < this.config.repeat_confidence * 0.5) {
            if (bestAsset && bestAsset !== this.activeAsset && bestScore >= this.config.repeat_confidence) {
                const oldAsset = this.activeAsset;
                this.activeAsset = bestAsset;
                this.targetDigit = bestDigit;
                this.ticksSinceAssetSwitch = 0;
                this.regime = this.regimes[bestAsset];

                logAsset(green(bold(`🔄 ASSET SWITCH: ${oldAsset || 'none'} → ${bestAsset} (score: ${currentScore} → ${bestScore}, digit: ${bestDigit})`)));

                this.sendTelegram(`🔄 <b>ASSET SWITCH</b>\n\n` +
                    `📊 ${oldAsset || 'none'} ➡️ <b>${bestAsset}</b>\n` +
                    `🎯 Score: ${currentScore} → ${bestScore}\n` +
                    `🔢 Target Digit: ${bestDigit}\n` +
                    `📜 Last10: ${this.tickHistories[bestAsset]?.slice(-10).join(',')}\n` +
                    `💰 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
                    `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L`);
            } else if (!this.activeAsset && bestAsset) {
                this.activeAsset = bestAsset;
                this.targetDigit = bestDigit;
                this.regime = this.regimes[bestAsset];
                logAsset(green(bold(`🎯 Initial asset selected: ${bestAsset} (score: ${bestScore}, digit: ${bestDigit})`)));
            }
        }
    }

    applyRegimeSignal(curDigit, asset) {
        this.targetDigit = curDigit;
        if (!this.regime || !this.regime.valid) { this.signalActive = false; return; }
        this.targetRepeatRate = this.regime.rawRepeatProb[curDigit];
        this.signalActive = this.regime.signalActive;
    }

    refreshSignalForLockedTarget(asset) {
        if (this.targetDigit < 0 || !this.regime || !this.regime.valid) return;
        this.targetRepeatRate = this.regime.rawRepeatProb[this.targetDigit];
        this.signalActive = this.regime.signalActive;
    }

    logRegimeAnalysis(curDigit, asset) {
        if (!this.regime || !this.regime.valid) return;
        const r = this.regime;
        const thr = this.config.repeat_threshold;

        const rateStr = r.rawRepeatProb.map((rp, i) => {
            if (i === curDigit) {
                const ok = rp < thr;
                return (ok ? green : red)(`${i}:${rp.toFixed(0)}%`);
            }
            return dim(`${i}:${rp.toFixed(0)}%`);
        }).join(' ');
        logAnalysis(`[${bold(asset)}] Rates: [${rateStr}]  recent=${r.recentRate.toFixed(1)}%`);

        const stateCol = r.hmmState === 0 ? green : yellow;
        const pnrPct = (r.posteriorNR * 100).toFixed(1);
        logHMM(
            `[${asset}] HMM: ${stateCol(bold(r.hmmStateName))} | ` +
            `P(NR): ${r.posteriorNR >= this.config.hmm_nonrep_confidence ? green(pnrPct + '%') : red(pnrPct + '%')} | ` +
            `Persist: ${r.hmmPersistence >= this.config.min_regime_persistence ? green(r.hmmPersistence + 't') : yellow(r.hmmPersistence + 't')}`
        );

        const bocpdOk = r.bocpdIsNonRep && r.bocpdPNonRep >= this.config.bocpd_nonrep_confidence;
        logBocpd(
            `[${asset}] BOCPD | P(NR): ${bocpdOk ? green((r.bocpdPNonRep * 100).toFixed(1) + '%') : red((r.bocpdPNonRep * 100).toFixed(1) + '%')} | ` +
            `ModeRL: ${r.bocpdModeRL >= this.config.bocpd_min_run_for_signal ? green(r.bocpdModeRL + 't') : yellow(r.bocpdModeRL + 't')}`
        );

        const cs = r.componentScores;
        logRegime(
            `[${asset}] Score: ${r.safetyScore >= this.config.repeat_confidence ? green(bold(r.safetyScore + '/100')) : red(r.safetyScore + '/100')} | ` +
            `BOCPD:${cs.bocpdScore.toFixed(1)} HMM:${cs.hmmScore.toFixed(1)} EWMA:${cs.ewmaScore.toFixed(1)} ` +
            `ACF:${cs.acfScore.toFixed(1)} Break:${cs.breakScore.toFixed(1)} CUSUM:${cs.cusumScore.toFixed(1)}`
        );

        if (this.signalActive) {
            logAnalysis(green(bold(
                `✅ [${asset}] SIGNAL ACTIVE — digit ${curDigit} | Score:${r.safetyScore}/100 → DIFFER`
            )));
        } else {
            const reasons = [];
            if (r.hmmState !== 0) reasons.push(`HMM=${r.hmmStateName}`);
            if (r.posteriorNR < this.config.hmm_nonrep_confidence) reasons.push(`P(NR)=${pnrPct}%`);
            if (r.hmmPersistence < this.config.min_regime_persistence) reasons.push(`persist=${r.hmmPersistence}`);
            if (!r.bocpdIsNonRep) reasons.push(`BOCPD:not_NR`);
            if (r.cusumUpAlarm) reasons.push(`CUSUM_ALARM`);
            if (r.safetyScore < this.config.repeat_confidence) reasons.push(`score=${r.safetyScore}`);
            logAnalysis(red(`⛔ [${asset}] NO SIGNAL — digit ${curDigit}: ${reasons.slice(0, 5).join(', ')}`));
        }
    }

    processSignal(curDigit) {
        if (!this.signalActive) { this.botState = BOT_STATE.ANALYZING; return; }
        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = BOT_STATE.GHOST_TRADING;
            const r = this.regime;
            logGhost(`👻 [${this.activeAsset}] Ghost started. Target: ${bold(cyan(this.targetDigit))} | Score:${r.safetyScore}/100`);
            this.runGhostCheck(curDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    runGhostCheck(curDigit) {
        if (this.botState !== BOT_STATE.GHOST_TRADING) return;
        if (!this.signalActive) {
            logGhost(dim(`⏳ [${this.activeAsset}] Signal lost — re-analyzing...`));
            this.resetGhost(); this.botState = BOT_STATE.ANALYZING; return;
        }
        this.ghostRoundsPlayed++;
        if (this.ghostAwaitingResult) {
            this.ghostAwaitingResult = false;
            if (curDigit !== this.targetDigit) {
                this.ghostConsecutiveWins++;
                logGhost(`👻 ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
            } else {
                const had = this.ghostConsecutiveWins; this.ghostConsecutiveWins = 0;
                logGhost(`👻 ${red('❌ Ghost LOSS — REPEATED')} (had ${had} wins) — reset`);
            }
        } else {
            if (curDigit === this.targetDigit) {
                const wic = this.ghostConsecutiveWins + 1;
                if (wic >= this.config.ghost_wins_required) {
                    this.ghostConsecutiveWins = wic; this.ghostConfirmed = true;
                    logGhost(green(bold(`✅ Ghost confirmed! Live trade NOW on ${this.activeAsset} digit ${this.targetDigit}`)));
                    this.executeTradeFlow(true);
                } else {
                    this.ghostAwaitingResult = true;
                    logGhost(`👻 Digit ${bold(cyan(this.targetDigit))} appeared | awaiting next...`);
                }
            }
        }
        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow('⚠️  Max ghost rounds. Re-analyzing...'));
            this.resetGhost(); this.botState = BOT_STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0; this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false; this.ghostAwaitingResult = false;
        this.targetDigit = -1; this.signalActive = false;
    }

    executeTradeFlow(immediate) {
        if (this.isTradeActive || this.pendingTrade || this.botState === BOT_STATE.STOPPED) return;
        if (!this.activeAsset) {
            logRisk('No active asset selected');
            this.botState = BOT_STATE.ANALYZING;
            return;
        }
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
            return;
        }
        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake) { logRisk('Stake>max'); this.stop('Stake exceeds max'); return; }
        if (this.currentStake > this.accountBalance) { this.stop('Insufficient balance'); return; }
        if (immediate) this.placeTrade();
        // else { this.pendingTrade = true; this.botState = BOT_STATE.GHOST_TRADING; logBot(`⚡ Recovery trade queued on ${this.activeAsset} digit ${bold(cyan(this.targetDigit))}`); }
    }

    placeTrade() {
        this.isTradeActive = true;
        this.botState = BOT_STATE.PLACING_TRADE;
        this.lastTradeAsset = this.activeAsset;
        const stepInfo = this.config.martingale_enabled ? ` | Mart:${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const r = this.regime;
        const score = r && r.valid ? r.safetyScore : 0;
        const pnr = r && r.valid ? (r.posteriorNR * 100).toFixed(1) + '%' : '?';

        logTrade(
            `🎯 [${bold(this.activeAsset)}] DIFFER from ${bold(cyan(this.targetDigit))} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo} | ` +
            `Score: ${score}/100 | P(NR): ${pnr}`
        );

        // ── Detailed Telegram: Trade Placed ──────────────────────────────────
        this.sendTelegram(
            `🎯 <b>TRADE on ${this.activeAsset}</b>\n\n` +
            `📊 ${this.activeAsset}\n` +
            `🔢 Digit: ${this.targetDigit}\n` +
            `📜 Last10: ${this.tickHistories[this.activeAsset]?.slice(-10).join(',')}\n` +
            `💰 Stake: $${this.currentStake.toFixed(2)}${stepInfo}\n` +
            `📈 Rate: ${this.targetRepeatRate.toFixed(1)}% | Score: ${score}/100\n` +
            `🔬 P(NR): ${pnr} | BOCPD_RL: ${r?.bocpdModeRL || '?'}t\n` +
            `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}`
        );

        this.send({
            buy: 1, price: this.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: this.activeAsset,
                duration: 1, duration_unit: 't', basis: 'stake',
                amount: this.currentStake,
                barrier: String(this.targetDigit),
                currency: this.config.currency,
            },
        });
        this.botState = BOT_STATE.WAITING_RESULT;
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        logTrade(dim(`Contract ${this.lastContractId} on ${this.lastTradeAsset} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${parseFloat(msg.buy.payout).toFixed(2)}`));
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;
        this.botState = BOT_STATE.PROCESSING_RESULT;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;

        const tradeAsset = this.lastTradeAsset || this.activeAsset;
        const resultDigit = this.tickHistories[tradeAsset]?.length > 0
            ? this.tickHistories[tradeAsset][this.tickHistories[tradeAsset].length - 1]
            : null;

        const won = profit > 0;
        if (won) this.processWin(profit, resultDigit, tradeAsset);
        else this.processLoss(this.lastBuyPrice, resultDigit, tradeAsset);

        // Adaptive ensemble feedback
        if (tradeAsset && this.detectors[tradeAsset]) {
            this.detectors[tradeAsset].applyTradeFeedback(won, this.regimes[tradeAsset]);
        }

        this.isTradeActive = false;

        // Save state after each trade
        this.persistence.save(this.getSerializableState());

        this.decideNextAction();
    }

    processWin(profit, resultDigit, asset) {
        this.totalWins++;
        this.sessionProfit += profit;
        this.currentWinStreak++;
        this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;

        // Per-asset stats
        if (asset && this.perAssetStats[asset]) {
            this.perAssetStats[asset].trades++;
            this.perAssetStats[asset].wins++;
            this.perAssetStats[asset].profit += profit;
        }

        if (asset && this.detectors[asset]) {
            this.detectors[asset].resetCUSUM(this.targetDigit);
        }

        const martInfo = this.config.martingale_enabled && this.martingaleStep > 0
            ? `\n🔄 Martingale recovered from step ${this.martingaleStep}!` : '';
        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));

        logResult(`${green('✅ WIN!')} [${asset}] Profit: ${green('+$' + profit.toFixed(2))} | P/L: ${plStr} | Bal: ${green('$' + this.accountBalance.toFixed(2))}`);
        if (resultDigit !== null) logResult(dim(`  Target:${this.targetDigit} Result:${resultDigit}`));

        // ── Detailed Telegram: Win ───────────────────────────────────────────
        this.sendTelegram(
            `✅ <b>WIN!</b>\n\n` +
            `📊 ${asset}\n` +
            `🔢 Digit: ${this.targetDigit} | Result: ${resultDigit}\n` +
            `📜 Last10: ${this.tickHistories[asset]?.slice(-10).join(',')}\n` +
            `💰 +$${profit.toFixed(2)} | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
            `📊 ${this.totalWins}W/${this.totalLosses}L${martInfo}\n` +
            `📊 WinRate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0'}%`
        );

        this.resetMartingale();
        this.resetGhost();
    }

    processLoss(lostAmount, resultDigit, asset) {
        this.totalLosses++;
        this.sessionProfit -= lostAmount;
        this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++;
        this.currentWinStreak = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

        // Per-asset stats
        if (asset && this.perAssetStats[asset]) {
            this.perAssetStats[asset].trades++;
            this.perAssetStats[asset].losses++;
            this.perAssetStats[asset].profit -= lostAmount;
        }

        const martInfo = this.config.martingale_enabled
            ? `\n🔄 Martingale: Step ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';

        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${red('❌ LOSS!')} [${asset}] Lost: ${red('-$' + lostAmount.toFixed(2))} | P/L: ${plStr}`);
        if (resultDigit !== null) logResult(dim(`  Target:${this.targetDigit} Result:${resultDigit} ${resultDigit === this.targetDigit ? red('REPEATED') : green('diff — unexpected')}`));

        // ── Detailed Telegram: Loss ──────────────────────────────────────────
        this.sendTelegram(
            `❌ <b>LOSS!</b>\n\n` +
            `📊 ${asset}\n` +
            `🔢 Digit: ${this.targetDigit} | Result: ${resultDigit}\n` +
            `📜 Last10: ${this.tickHistories[asset]?.slice(-10).join(',')}\n` +
            `💸 -$${lostAmount.toFixed(2)} | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
            `📊 ${this.totalWins}W/${this.totalLosses}L${martInfo}\n` +
            `📊 WinRate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0'}%`
        );

        this.ghostConsecutiveWins = 0;
        this.ghostConfirmed = false;
        this.ghostRoundsPlayed = 0;
        this.ghostAwaitingResult = false;
    }

    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }
        if (this.config.martingale_enabled && this.martingaleStep > 0 && this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`📈 Martingale recovery step ${this.martingaleStep}/${this.config.max_martingale_steps} on ${this.activeAsset}...`));
            this.botState = this.config.ghost_enabled ? BOT_STATE.GHOST_TRADING : BOT_STATE.ANALYZING;
            if (!this.config.ghost_enabled) this.executeTradeFlow(false);
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk('🛑 Max Martingale steps reached!');
            this.resetMartingale();
            this.startCooldown();
            return;
        }
        this.botState = BOT_STATE.ANALYZING;
    }

    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) return this.config.base_stake;
        const raw = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
        const calc = Math.round(raw * 100) / 100;
        const final = Math.min(calc, this.config.max_stake);
        logBot(dim(`Mart: Step ${this.martingaleStep} | $${this.config.base_stake}×${this.config.martingale_multiplier}^${this.martingaleStep}=$${calc.toFixed(2)} → $${final.toFixed(2)}`));
        return final;
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(
                `🎉 <b>TAKE PROFIT HIT!</b>\n\n` +
                `💰 P&L: +$${this.sessionProfit.toFixed(2)}\n` +
                `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L\n` +
                `📊 WinRate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0'}%\n` +
                `💵 Balance: $${this.accountBalance.toFixed(2)}\n` +
                `⏱ Duration: ${formatDuration(Date.now() - this.sessionStartTime)}\n` +
                `\n📊 <b>Per-Asset Performance:</b>\n` +
                this.formatPerAssetStats()
            );
            return { canTrade: false, reason: `🎯 Take profit! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(
                `🛑 <b>STOP LOSS HIT!</b>\n\n` +
                `💸 P&L: -$${Math.abs(this.sessionProfit).toFixed(2)}\n` +
                `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L\n` +
                `📊 WinRate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0'}%\n` +
                `💵 Balance: $${this.accountBalance.toFixed(2)}\n` +
                `⏱ Duration: ${formatDuration(Date.now() - this.sessionStartTime)}\n` +
                `\n📊 <b>Per-Asset Performance:</b>\n` +
                this.formatPerAssetStats()
            );
            return { canTrade: false, reason: `🛑 Stop loss! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const ns = (!this.config.martingale_enabled || this.martingaleStep === 0)
            ? this.config.base_stake
            : Math.min(Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep) * 100) / 100, this.config.max_stake);
        if (ns > this.accountBalance) return { canTrade: false, reason: 'Next stake>balance', action: 'STOP' };
        if (ns > this.config.max_stake) return { canTrade: false, reason: 'Next stake>max', action: 'STOP' };
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: 'Max Martingale steps reached.', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    formatPerAssetStats() {
        return Object.entries(this.perAssetStats)
            .filter(([_, s]) => s.trades > 0)
            .sort((a, b) => b[1].profit - a[1].profit)
            .map(([sym, s]) => {
                const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : '0';
                return `  • ${sym}: ${s.trades}T ${s.wins}W/${s.losses}L ${s.profit >= 0 ? '+' : ''}$${s.profit.toFixed(2)} (${wr}%)`;
            })
            .join('\n') || '  No trades yet';
    }

    resetMartingale() {
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = this.config.base_stake;
    }

    startCooldown() {
        this.botState = BOT_STATE.COOLDOWN;
        this.resetMartingale();
        this.resetGhost();
        logBot(`⏸️  Cooldown ${this.config.cooldown_after_max_loss / 1000}s...`);

        this.sendTelegram(
            `⏸ <b>COOLDOWN</b>\n\n` +
            `⏱ Duration: ${this.config.cooldown_after_max_loss / 1000}s\n` +
            `📊 Active: ${this.activeAsset}\n` +
            `💰 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
            `📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L`
        );

        this.cooldownTimer = setTimeout(() => {
            if (this.botState === BOT_STATE.COOLDOWN) {
                logBot(green('▶️  Cooldown ended. Resuming...'));
                this.botState = BOT_STATE.ANALYZING;
                // Re-scan assets after cooldown
                this.scanAllAssets();
            }
        }, this.config.cooldown_after_max_loss);
    }

    stop(reason = 'User stopped') {
        this.botState = BOT_STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping.')} Reason: ${reason}`);

        // Save final state
        this.persistence.save(this.getSerializableState());
        this.persistence.stopAutoSave();

        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.pendingTrade = false;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) { }
            setTimeout(() => { try { this.ws.close(); } catch (_) { } }, 500);
        }

        // ── Detailed Telegram: Stop ──────────────────────────────────────────
        this.sendTelegram(
            `🛑 <b>BOT STOPPED</b>\n\n` +
            `📝 Reason: ${reason}\n` +
            `⏱ Duration: ${formatDuration(Date.now() - this.sessionStartTime)}\n\n` +
            `📊 <b>Session Summary:</b>\n` +
            `  Total Trades: ${this.totalTrades}\n` +
            `  Wins: ${this.totalWins} | Losses: ${this.totalLosses}\n` +
            `  WinRate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0'}%\n` +
            `  P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}\n` +
            `  Starting: $${this.startingBalance.toFixed(2)}\n` +
            `  Final: $${this.accountBalance.toFixed(2)}\n` +
            `  Max Win Streak: ${this.maxWinStreak}\n` +
            `  Max Loss Streak: ${this.maxLossStreak}\n` +
            `  Max Martingale: Step ${this.maxMartingaleReached}\n` +
            `  Largest Win: +$${this.largestWin.toFixed(2)}\n` +
            `  Largest Loss: -$${this.largestLoss.toFixed(2)}\n\n` +
            `📊 <b>Per-Asset Performance:</b>\n` +
            this.formatPerAssetStats()
        );

        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════════════════════')));
        logStats(bold(cyan('                    SESSION SUMMARY (v4.0 Multi-Asset)         ')));
        logStats(bold(cyan('═══════════════════════════════════════════════════════════════')));
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
        logStats(`  Assets Traded    : ${bold(this.config.symbols.length)}`);
        logStats(`  Total Trades     : ${bold(this.totalTrades)}`);
        logStats(`  Wins             : ${green(this.totalWins)}`);
        logStats(`  Losses           : ${red(this.totalLosses)}`);
        logStats(`  Win Rate         : ${bold(wr + '%')}`);
        logStats(`  Session P/L      : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance : $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance    : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Avg P/L/Trade    : ${formatMoney(avg)}`);
        logStats(`  Largest Win      : ${green('+$' + this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss     : ${red('-$' + this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak   : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak  : ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale   : Step ${this.maxMartingaleReached}`);
        logStats('');
        logStats(bold(cyan('  Per-Asset Performance:')));
        for (const [sym, s] of Object.entries(this.perAssetStats)) {
            if (s.trades > 0) {
                const awr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
                const apl = s.profit >= 0 ? green(formatMoney(s.profit)) : red(formatMoney(s.profit));
                logStats(`    ${bold(sym)}: ${s.trades}T ${s.wins}W/${s.losses}L WR:${awr}% P/L:${apl}`);
            }
        }
        logStats(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log('');
    }
}


// ── Entry Point ──────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();
    const bot = new MultiAssetGhostBot(config);

    process.on('SIGINT', () => {
        console.log('');
        bot.persistence.save(bot.getSerializableState());
        bot.stop('SIGINT');
    });
    process.on('SIGTERM', () => {
        bot.persistence.save(bot.getSerializableState());
        bot.stop('SIGTERM');
    });
    process.on('uncaughtException', e => {
        logError(`Uncaught: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.persistence.save(bot.getSerializableState());
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', r => logError(`Rejection: ${r}`));

    bot.start();
})();
