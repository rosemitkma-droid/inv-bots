#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v3.0 Precision Regime Detection
//  Deriv Digit Differ — Multi-Method Ensemble Regime Engine
//
//  UPGRADED REGIME ENGINE v3.0:
//    1. Bayesian Online Changepoint Detection (BOCPD) — Adams & MacKay 2007
//       • Beta-Bernoulli conjugate model on repeat indicator sequence
//       • Maintains full P(run_length | observations) posterior
//       • Detects PRECISE regime boundaries with calibrated certainty
//
//    2. 2-State HMM with 10×10 Digit Transition Matrix Emissions
//       • Observes full digit-to-digit transitions (100 symbols)
//       • REP state: diagonal P(d→d) elevated; NON-REP: near uniform
//       • Baum-Welch with log-space arithmetic, label-switching guard
//
//    3. Multi-Scale EWMA Stack (4 time horizons)
//       • Ultra-short (~4t), Short (~15t), Medium (~40t), Long (~100t)
//       • Trend signal = short − long (rising trend → danger)
//       • Consensus gate: all scales must read low repeat
//
//    4. Lag Autocorrelation Analysis of Repeat Sequence
//       • Computes ACF at lags 1–5 of the binary repeat indicator
//       • Positive AC → repeat clustering → REP regime
//       • Near-zero or negative AC → non-clustering → NON-REP regime
//
//    5. Structural Break Detector (rolling likelihood ratio)
//       • Splits window into two halves, compares repeat rates
//       • Large shift → regime boundary detected recently
//
//    6. Two-Sided CUSUM (per digit + global)
//       • Up-CUSUM: catches shift INTO rep regime → blocks trades
//       • Down-CUSUM: confirms sustained exit from rep regime
//       • Both must agree before trade is enabled
//
//    7. Non-Parametric Repeat Rate Test
//       • Compares recent 20-tick repeat count against historical base
//       • Uses exact Binomial CDF tail probability
//
//    8. Weighted Ensemble with Dynamic Component Trust
//       • Each component votes with a confidence weight
//       • Weights decay when a component has recently misfired
//       • Final score 0–100; trade requires ≥ configurable threshold
//
//  TRADE CONDITIONS (ALL must hold):
//    a) BOCPD run-length posterior → currently in long non-rep run
//    b) P(NON-REP | observations) from BOCPD ≥ hmm_nonrep_confidence
//    c) HMM Viterbi → current state = NON-REP, persistence ≥ threshold
//    d) Bayesian posterior P(NON-REP) from Forward algorithm ≥ threshold
//    e) All EWMA scales read repeat rate below threshold
//    f) EWMA trend (short − long) ≤ 0 (not rising toward rep regime)
//    g) Lag-1 ACF of repeat sequence < acf_threshold
//    h) Up-CUSUM shows NO recent shift into rep regime
//    i) Down-CUSUM confirms we are in a sustained low-repeat period
//    j) Ensemble score ≥ repeat_confidence
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

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
    REGIME: 'magenta',
};
const loggers = {};
['BOT', 'API', 'TICK', 'ANALYSIS', 'GHOST', 'TRADE', 'RESULT', 'RISK', 'STATS', 'ERROR', 'HMM', 'BOCPD', 'REGIME'].forEach(p => {
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
    REGIME: logRegime } = loggers;

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        symbol: 'R_75',
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // History
        tick_history_size: 5000,
        analysis_window: 5000,
        min_ticks_for_analysis: 50,

        // ── Regime detection thresholds ───────────────────────────────────────
        repeat_threshold: 11,           // Hard gate: raw repeat % per digit
        hmm_nonrep_confidence: 0.85,   // Bayesian P(NON-REP) required from HMM forward
        bocpd_nonrep_confidence: 0.82, // BOCPD P(NON-REP) required
        min_regime_persistence: 8,     // Min consecutive ticks in NON-REP (HMM Viterbi)
        acf_lag1_threshold: 0.15,      // Lag-1 ACF gate (< threshold = ok)
        ewma_trend_threshold: 2.0,     // EWMA trend gate (short-long, %)
        // CUSUM — uses FIXED p0=0.10, p1=0.40 internally (NOT from HMM diagonals)
        // With correct LLRs: no-repeat LLR=-0.405, repeat LLR=+1.386, slack=0.15
        // At 5% repeat rate, CUSUM drifts: 0.95*(-0.405-0.15) + 0.05*(1.386-0.15) = -0.464/tick
        // → clears in ~10 non-rep ticks after last alarm trigger
        cusum_up_threshold: 3.5,       // Up-CUSUM alarm (rep regime shift detector)
        cusum_down_threshold: -4.0,    // Down-CUSUM confirmation (non-rep sustained)
        cusum_slack: 0.15,             // CRITICAL: must be large enough that non-rep ticks drain CUSUM
        structural_break_threshold: 0.15, // P-value threshold for structural break

        // BOCPD
        bocpd_hazard: 1 / 150,        // Expected regime length ~150 ticks
        bocpd_prior_alpha: 1,         // Beta prior α (successes = repeats)
        bocpd_prior_beta: 9,          // Beta prior β (favours ~10% repeat baseline)
        bocpd_min_run_for_signal: 15, // Min run length in non-rep regime to trust

        // Binary HMM
        hmm_refit_every: 50,           // Refit Baum-Welch every N ticks
        hmm_min_discrimination: 0.10,  // Min B[1][1]-B[0][1] gap to accept BW update

        // Ensemble
        repeat_confidence: 70,         // Final ensemble score gate (0–100)

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
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac = parts.length > 1 ? parts[1] : '';
    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset))
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

// Binomial log-PMF: log C(n,k) + k*log(p) + (n-k)*log(1-p)
function binomialLogPMF(k, n, p) {
    if (p <= 0) return k === 0 ? 0 : -Infinity;
    if (p >= 1) return k === n ? 0 : -Infinity;
    let logC = 0;
    for (let i = 0; i < k; i++) logC += Math.log(n - i) - Math.log(i + 1);
    return logC + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

// Regularised incomplete beta (for Binomial CDF approximation via Beta)
// Uses continued fraction — accurate for our range
function betaIncomplete(x, a, b) {
    // Lentz continued fraction
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    return front * continuedFraction(x, a, b);
}
function lgamma(z) {
    // Lanczos approximation
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
    let f = 1, C = 1, D = 1 - (a + b) * x / (a + 1);
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D; f = D;
    for (let m = 1; m <= MAX; m++) {
        let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
        D = 1 + aa * D; C = 1 + aa / C;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(C) < 1e-30) C = 1e-30;
        D = 1 / D; let delta = C * D; f *= delta;
        aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
        D = 1 + aa * D; C = 1 + aa / C;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(C) < 1e-30) C = 1e-30;
        D = 1 / D; delta = C * D; f *= delta;
        if (Math.abs(delta - 1) < EPS) break;
    }
    return f;
}

// ── State Constants ────────────────────────────────────────────────────────────
const STATE = {
    INITIALIZING: 'INITIALIZING', CONNECTING: 'CONNECTING', AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS', ANALYZING: 'ANALYZING', GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE', WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT', COOLDOWN: 'COOLDOWN', STOPPED: 'STOPPED',
};

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 1: BAYESIAN ONLINE CHANGEPOINT DETECTION (BOCPD)
//
//  Algorithm: Adams & MacKay 2007, "Bayesian Online Changepoint Detection"
//
//  Model:
//    Observations: o_t ∈ {0,1}  (0=no repeat, 1=repeat)
//    Underlying process: Bernoulli(θ_r) within each regime segment
//    Prior on θ: Beta(α₀, β₀)  → conjugate update
//    Changepoint probability: h = P(regime ends at any tick) = 1/λ
//
//  Run-length distribution:
//    r_t ∈ {0,1,2,...,t} = how many ticks since last changepoint
//    P(r_t=0 | x_{1:t}) = probability we're at a fresh changepoint
//    P(r_t=k | x_{1:t}) = probability current run has lasted k ticks
//
//  Inference:
//    Message passing over run lengths in O(t) time per tick
//    Each "run" maintains its own Beta posterior: (α_r + obs_sum, β_r + (n - obs_sum))
//    Predictive probability: Beta-Bernoulli predictive
//
//  Output:
//    - pNonRep: probability current regime is non-repetitive
//      estimated from current-run posterior θ estimate vs baseline
//    - currentRunLength: expected run length given current posterior
//    - inNonRepRegime: boolean from run length posterior + θ estimate
// ══════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard = config.bocpd_hazard;
        this.alpha0 = config.bocpd_prior_alpha;
        this.beta0 = config.bocpd_prior_beta;
        this.minRun = config.bocpd_min_run_for_signal;
        this.threshold = config.bocpd_nonrep_confidence;

        // Log run-length posterior: logR[r] = log P(run_length = r | x_{1:t})
        // Maintained as a sparse array (grow over time)
        this.logR = [0]; // start: log P(r=0) = 0 → P=1 (no history yet)
        this.alphas = [this.alpha0];  // sufficient stats per run length
        this.betas = [this.beta0];

        this.t = 0;
        this.lastChangepoint = 0;

        // History of most probable run lengths (for trend analysis)
        this.runHistory = [];
        // History of per-tick repeat obs (for later ACF / structural break)
        this.obsHistory = [];

        // Current regime estimate (inferred from BOCPD posterior)
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }

    // Update BOCPD with a new binary observation (0=no-repeat, 1=repeat)
    update(obs) {
        this.t++;
        this.obsHistory.push(obs);

        const H = this.hazard;
        const lenR = this.logR.length; // current number of tracked run lengths

        // ── Predictive probability P(x_t | r_{t-1}, suff. stats) ─────────────
        // For Beta-Bernoulli: P(x=1 | α, β) = α / (α + β)
        const logPredictive = new Array(lenR);
        for (let r = 0; r < lenR; r++) {
            const theta = this.alphas[r] / (this.alphas[r] + this.betas[r]);
            const p = obs === 1 ? theta : (1 - theta);
            logPredictive[r] = Math.log(Math.max(p, 1e-300));
        }

        // ── Hazard: P(r_t = 0 | r_{t-1} = r) = H, P(growth | r_{t-1}=r) = 1-H
        // New run-length posterior (before normalisation):
        //   P(r_t = r | x_{1:t}) ∝ P(x_t | r, suff) * [P(r_t|r_{t-1}) * P(r_{t-1}|x_{1:t-1})]

        // Growth: r_t = r+1 from r_{t-1}=r with prob (1-H)
        const logGrowthMass = logPredictive.map((lp, r) => lp + Math.log(1 - H) + this.logR[r]);
        // Changepoint: r_t = 0 from any r_{t-1}=r with prob H
        const logChangepointMass = logSumExp(logPredictive.map((lp, r) => lp + Math.log(H) + this.logR[r]));

        // Build new logR: index 0 = changepoint, indices 1..lenR = growth
        const newLogR = new Array(lenR + 1);
        const newAlphas = new Array(lenR + 1);
        const newBetas = new Array(lenR + 1);

        // r_t = 0 (changepoint): reset to prior
        newLogR[0] = logChangepointMass;
        newAlphas[0] = this.alpha0 + obs;
        newBetas[0] = this.beta0 + (1 - obs);

        // r_t = r+1 (growth)
        for (let r = 0; r < lenR; r++) {
            newLogR[r + 1] = logGrowthMass[r];
            newAlphas[r + 1] = this.alphas[r] + obs;
            newBetas[r + 1] = this.betas[r] + (1 - obs);
        }

        // Normalise
        const logZ = logSumExp(newLogR);
        this.logR = newLogR.map(v => v - logZ);
        this.alphas = newAlphas;
        this.betas = newBetas;

        // ── Prune small-probability run lengths to cap memory ──────────────────
        if (this.logR.length > 800) {
            // Keep only run lengths with log-prob > -20 (very small prob)
            const threshold = Math.max(...this.logR) - 15;
            const keep = this.logR.map((v, i) => i).filter(i => this.logR[i] > threshold);
            // Always keep r=0
            if (!keep.includes(0)) keep.unshift(0);
            this.logR = keep.map(i => this.logR[i]);
            this.alphas = keep.map(i => this.alphas[i]);
            this.betas = keep.map(i => this.betas[i]);
            // Re-normalise after pruning
            const logZ2 = logSumExp(this.logR);
            this.logR = this.logR.map(v => v - logZ2);
        }

        // ── Derive regime estimates ────────────────────────────────────────────
        // Expected run length under posterior
        const probs = this.logR.map(Math.exp);
        this.expectedRunLength = probs.reduce((s, p, r) => s + p * r, 0);

        // Detect most probable run length
        const modeIdx = this.logR.indexOf(Math.max(...this.logR));

        // θ estimate at mode run length: posterior mean
        const thetaMode = this.alphas[modeIdx] / (this.alphas[modeIdx] + this.betas[modeIdx]);

        // P(non-rep regime) = P(θ < baseline, sustained run in low-repeat regime)
        // We define: if thetaMode < baseline (say 0.15) AND run is long → non-rep
        // Combine: weight by P(run_length ≥ minRun) and P(θ < baselineThreshold)
        const pLongRun = probs.slice(this.minRun).reduce((s, p) => s + p, 0);
        // θ credible: P(θ < 0.15 | α, β) using Beta CDF
        const pLowTheta = betaIncomplete(0.15, this.alphas[modeIdx], this.betas[modeIdx]);

        this.pNonRep = clamp(pLongRun * 0.5 + pLowTheta * 0.5, 0, 1);

        // Save snapshot
        this.runHistory.push({ t: this.t, modeRL: modeIdx, theta: thetaMode, pNonRep: this.pNonRep });
        if (this.runHistory.length > 200) this.runHistory.shift();

        return {
            pNonRep: this.pNonRep,
            expectedRL: this.expectedRunLength,
            modeRL: modeIdx,
            thetaEstimate: thetaMode,
            pLongRun,
            pLowTheta,
            pChangepoint: Math.exp(this.logR[0]),  // probability we just had a changepoint
        };
    }

    // Check if we're confidently in a non-rep regime
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
//  COMPONENT 2: 2-STATE BINARY HMM (repeat / no-repeat observations)
//
//  WHY BINARY INSTEAD OF 10×10:
//    The 10×10 pair model has 100 emission parameters per state.
//    At ~5-10% repeat rate with 5000 ticks we only see ~250-500 repeat
//    events split across 100 pair types — ~2-5 diagonal events per cell.
//    Baum-Welch cannot estimate 200 emission params reliably from that,
//    causing BOTH states to converge to near-uniform emissions (0.5% vs 1.6%).
//    With near-identical emissions, Viterbi decoding is essentially random
//    (persistence resets every 1-3 ticks) and the forward posterior swings
//    wildly between 0% and 100%.
//
//  Binary HMM has only 4 emission parameters (2 per state):
//    B[0] = [P(no-repeat|NR), P(repeat|NR)]  e.g. [0.91, 0.09]
//    B[1] = [P(no-repeat|REP), P(repeat|REP)] e.g. [0.55, 0.45]
//    → LLR per repeat = log(0.45/0.09) ≈ 1.61  (strong signal!)
//    → Baum-Welch converges reliably with hundreds of observations
//    → Viterbi produces stable, meaningful regime sequences
//    → Forward posterior smoothly transitions between states
//
//  Baum-Welch acceptance gate:
//    After re-estimation, if discrimination (B[1][1] - B[0][1]) < threshold
//    (typically 0.10), the update is REJECTED and old params are kept.
//    This prevents collapse when the asset is in extended non-rep regimes
//    that leave too few repeat events for robust estimation.
// ══════════════════════════════════════════════════════════════════════════════
class BinaryHMM {
    constructor(config) {
        this.cfg = config;
        this.MIN_DISCRIM = config.hmm_min_discrimination || 0.10;

        // Initial distribution: bias toward NON-REP
        this.pi = [0.65, 0.35];

        // Transition matrix: REP regimes are sticky but NON-REP is stickier
        this.A = [
            [0.93, 0.07],   // NON-REP → NON-REP, NON-REP → REP
            [0.22, 0.78],   // REP → NON-REP,     REP → REP
        ];

        // Binary emission: B[state][obs],  obs=0: no-repeat,  obs=1: repeat
        // Informed priors based on known asset behaviour:
        //   NON-REP: ~9% repeat probability (close to random 10%)
        //   REP:     ~45% repeat probability (strongly elevated)
        this.B = [
            [0.91, 0.09],   // NON-REP state
            [0.55, 0.45],   // REP state
        ];

        // Forward vector (log-space) — maintained incrementally
        this.logAlpha = [Math.log(0.65), Math.log(0.35)];
        this.fitted = false;
        this.lastFitDiscrim = 0;
    }

    // Build binary observation sequence: 1 if digit[t] = digit[t-1], else 0
    buildObs(digitSeq) {
        const obs = new Array(digitSeq.length - 1);
        for (let t = 1; t < digitSeq.length; t++) {
            obs[t - 1] = digitSeq[t] === digitSeq[t - 1] ? 1 : 0;
        }
        return obs;
    }

    // ── Baum-Welch EM parameter estimation ─────────────────────────────────────
    baumWelch(obs, maxIter = 30, tol = 1e-6) {
        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };

        let pi = [...this.pi];
        let A = this.A.map(r => [...r]);
        let B = this.B.map(r => [...r]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            // ── Forward (log-space) ───────────────────────────────────────────
            const logAlpha = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    const inc = [0, 1].map(p => logAlpha[t - 1][p] + Math.log(A[p][s] + 1e-300));
                    logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }
            const logL = logSumExp(logAlpha[T - 1]);

            // ── Backward (log-space) ──────────────────────────────────────────
            const logBeta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T - 1][s] = 0;
            for (let t = T - 2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    const vals = [0, 1].map(nx => Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx]);
                    logBeta[t][s] = logSumExp(vals);
                }
            }

            // ── Gamma (state occupancy) ───────────────────────────────────────
            const logGamma = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - d;
            }

            // ── Xi (transition counts) ────────────────────────────────────────
            const logXi = Array.from({ length: T - 1 }, () => Array.from({ length: N }, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T - 1; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) for (let nx = 0; nx < N; nx++) {
                    logXi[t][s][nx] = logAlpha[t][s] + Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx] - d;
                }
            }

            // ── M-step ────────────────────────────────────────────────────────
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

        // ── Label-switching guard: state 0 must be NON-REP (lower repeat emission)
        if (B[0][1] > B[1][1]) {
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        const discrimination = B[1][1] - B[0][1];

        // ── Acceptance gate: reject if states collapsed to near-identical emissions
        if (discrimination < this.MIN_DISCRIM) {
            return {
                accepted: false, discrimination, repeatNR: B[0][1], repeatREP: B[1][1],
                reason: `discrimination ${(discrimination * 100).toFixed(1)}% < ${(this.MIN_DISCRIM * 100).toFixed(0)}% threshold — keeping prior params`
            };
        }

        this.pi = pi; this.A = A; this.B = B;
        this.fitted = true;
        this.lastFitDiscrim = discrimination;
        return { accepted: true, discrimination, repeatNR: B[0][1], repeatREP: B[1][1] };
    }

    // ── Viterbi decoding ────────────────────────────────────────────────────────
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

    // ── Forward algorithm (incremental, O(N²) per tick) ────────────────────────
    updateForward(obs_t) {
        const N = 2;
        const newLogA = new Array(N);
        for (let s = 0; s < N; s++) {
            const inc = this.logAlpha.map((la, p) => la + Math.log(this.A[p][s] + 1e-300));
            newLogA[s] = logSumExp(inc) + Math.log(this.B[s][obs_t] + 1e-300);
        }
        const d = logSumExp(newLogA);
        this.logAlpha = newLogA;
        return [Math.exp(newLogA[0] - d), Math.exp(newLogA[1] - d)];
    }

    // Repeat emission probability for a given state
    repeatEmission(state) { return this.B[state][1]; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 3: MULTI-SCALE EWMA STACK
//  Tracks repeat rate at 4 different time horizons simultaneously.
// ══════════════════════════════════════════════════════════════════════════════
class EWMAStack {
    constructor() {
        // λ values: larger = shorter memory
        this.lambdas = [0.40, 0.18, 0.07, 0.025];
        this.names = ['ultra-short(~4t)', 'short(~15t)', 'medium(~40t)', 'long(~100t)'];
        this.values = [null, null, null, null];  // null until enough data
        this.n = 0;
    }

    update(repeatObs) {
        // repeatObs = 100 if repeat, 0 if not
        const v = repeatObs * 100;
        this.n++;
        for (let i = 0; i < 4; i++) {
            if (this.values[i] === null) {
                this.values[i] = v;
            } else {
                this.values[i] = this.lambdas[i] * v + (1 - this.lambdas[i]) * this.values[i];
            }
        }
    }

    get(idx) { return this.values[idx] ?? 50; }

    // Trend: short - long (positive = repeat rate rising = danger)
    trend() { return this.get(1) - this.get(3); }

    // All scales agree on low repeat?
    allBelowThreshold(threshold) {
        return this.values.every(v => v === null || v < threshold);
    }

    summary() {
        return this.names.map((n, i) => `${n}=${this.get(i).toFixed(1)}%`).join(' | ');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 4: LAG AUTOCORRELATION OF REPEAT SEQUENCE
//  ACF of the binary {0,1} repeat indicator at lags 1..maxLag.
//  Positive AC → repeats cluster together → REP regime
//  Near-zero or negative → repeats are scattered → NON-REP
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
        for (let t = 0; t < n - lag; t++) {
            cov += (seq[t] - mean) * (seq[t + lag] - mean);
        }
        acf.push(cov / ((n - lag) * variance));
    }
    return acf;
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 5: STRUCTURAL BREAK DETECTOR
//  Splits the recent window into two halves and compares repeat rates.
//  Uses a Likelihood Ratio Test against H₀: same rate in both halves.
//  Returns { lrtStat, pBreak } where pBreak ≈ P(structural break occurred).
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

    // Log-likelihood ratio: 2*(LL_alt - LL_null), asymptotically χ²(1)
    function logLik(k, n, p) {
        if (p <= 0 || p >= 1) return 0;
        return k * Math.log(p) + (n - k) * Math.log(1 - p);
    }
    const llAlt = logLik(k1, n1, p1) + logLik(k2, n2, p2);
    const llNull = logLik(k1 + k2, n1 + n2, pPool);
    const lrtStat = 2 * (llAlt - llNull);

    // Approximate p-value from χ²(1) using Wilson-Hilferty
    // pBreak = P(regime changed) ≈ 1 - chi2CDF(lrt, 1) for detection
    const chi2cdf = lrtStat <= 0 ? 0 : Math.min(0.9999,
        1 - Math.exp(-0.5 * Math.pow(Math.max(0, lrtStat), 1) * 0.5));
    // A large LRT → high probability of a structural break
    // Shift occurred from old to new: p2 > p1 = bad (moving into rep)
    const pBreak = p2 > p1 ? chi2cdf : 0; // only care about upward breaks (into rep)

    return { lrtStat: Math.max(0, lrtStat), pBreak, rateOld: p1, rateNew: p2 };
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 6: TWO-SIDED CUSUM
//  Up-CUSUM:   detects shift INTO rep regime (blocks trades on alarm)
//  Down-CUSUM: detects shift INTO non-rep regime (confirms non-rep)
// ══════════════════════════════════════════════════════════════════════════════
class TwoSidedCUSUM {
    constructor(config) {
        this.slack = config.cusum_slack;
        this.upThr = config.cusum_up_threshold;
        this.downThr = config.cusum_down_threshold;  // negative threshold for down-CUSUM

        // Per-digit CUSUM values
        this.upC = new Array(10).fill(0);
        this.downC = new Array(10).fill(0);

        // Global CUSUM (all repeats, not per-digit)
        this.globalUp = 0;
        this.globalDown = 0;
    }

    // p0: expected repeat prob in NON-REP (baseline ~10%)
    // p1: expected repeat prob in REP (elevated ~40%)
    update(digit, isRepeat, p0 = 0.10, p1 = 0.40) {
        const obs = isRepeat ? 1 : 0;
        // Log-likelihood ratio: log P(obs | REP) / P(obs | NON-REP)
        const logLR = Math.log((isRepeat ? p1 : (1 - p1)) / ((isRepeat ? p0 : (1 - p0)) + 1e-300) + 1e-300);

        // Up-CUSUM: accumulated evidence for shift INTO rep
        this.upC[digit] = Math.max(0, this.upC[digit] + logLR - this.slack);
        this.downC[digit] = Math.min(0, this.downC[digit] + logLR + this.slack);

        // Global
        this.globalUp = Math.max(0, this.globalUp + logLR - this.slack);
        this.globalDown = Math.min(0, this.globalDown + logLR + this.slack);
    }

    resetDigit(d) { this.upC[d] = 0; this.downC[d] = 0; }
    resetGlobal() { this.globalUp = 0; this.globalDown = 0; }

    upAlarm(digit) { return this.upC[digit] > this.upThr || this.globalUp > this.upThr; }
    downConfirmed(digit) {
        // Down-CUSUM goes negative; confirmed when sufficiently negative
        return this.downC[digit] < this.downThr && this.globalDown < this.downThr;
    }

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

        // Sub-components
        this.bocpd = new BOCPD(config);
        this.hmm = new BinaryHMM(config);   // ← Binary HMM (not 10×10)
        this.ewma = new EWMAStack();
        this.cusum = new TwoSidedCUSUM(config);

        // Per-digit repeat rate (transition-based, sliding window)
        this.perDigitRate = new Array(10).fill(10); // initialise to 10% baseline

        // Raw repeat obs buffer for ACF + structural break
        this.repeatBuffer = [];
        this.BUFFER_MAX = 500;

        // Component trust weights (adaptive) — updated after each resolved trade
        this.weights = { bocpd: 1.0, hmm: 1.0, ewma: 1.0, acf: 0.7, structural: 0.6, cusum: 1.0 };

        // HMM refit counter
        this.ticksSinceRefit = 0;
        this.hmmResult = null;
        this.bocpdResult = null;
    }

    // ── Per-digit repeat rate (full transition counting) ──────────────────────
    computePerDigitRepeatRate(window) {
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);
        for (let i = 0; i < window.length - 1; i++) {
            transFrom[window[i]]++;
            if (window[i + 1] === window[i]) transRepeat[window[i]]++;
        }
        return transFrom.map((n, d) => n > 0 ? (transRepeat[d] / n) * 100 : 10);
    }

    // ── Main per-tick incremental update ─────────────────────────────────────
    // Call this for EVERY new tick (before analyze() for trade decision)
    tick(prevDigit, curDigit) {
        const isRepeat = prevDigit === curDigit;
        const obs_binary = isRepeat ? 1 : 0;

        // BOCPD update
        this.bocpdResult = this.bocpd.update(obs_binary);

        // EWMA stack update
        this.ewma.update(obs_binary);

        // ── CUSUM update — always use FIXED p0=0.10, p1=0.40 ─────────────────
        // CRITICAL: Do NOT use HMM diagonal emissions as p0/p1.
        // With Baum-Welch that converges to near-uniform (0.5% vs 1.6%),
        // the LLR for no-repeat becomes tiny (-0.011) and slack=0.005 barely
        // drains the CUSUM, causing permanent stuck alarms.
        // With p0=0.10, p1=0.40:
        //   No-repeat LLR = log(0.60/0.90) = -0.405; net = -0.405 - slack = fast drain
        //   Repeat LLR    = log(0.40/0.10) = +1.386; net = +1.386 - slack
        // At 5% repeat rate: E[CUSUM/tick] = 0.05*1.236 + 0.95*(-0.555) = -0.464 → drains fast
        this.cusum.update(prevDigit, isRepeat, 0.10, 0.40);

        // Append to repeat buffer
        this.repeatBuffer.push(obs_binary);
        if (this.repeatBuffer.length > this.BUFFER_MAX) this.repeatBuffer.shift();

        this.ticksSinceRefit++;
    }

    // ── Full analysis (called on each analysis tick) ───────────────────────────
    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;

        if (len < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: `insufficient data (${len}/${this.cfg.min_ticks_for_analysis})` };
        }

        // ── Build BINARY observation sequence for HMM ─────────────────────────
        // obs[t] = 1 if window[t+1] === window[t], else 0
        const binaryObs = this.hmm.buildObs(window);

        // ── Refit HMM via Baum-Welch if needed ────────────────────────────────
        if (!this.hmm.fitted || this.ticksSinceRefit >= this.cfg.hmm_refit_every) {
            const fitResult = this.hmm.baumWelch(binaryObs);
            this.ticksSinceRefit = 0;
            if (fitResult) {
                if (fitResult.accepted) {
                    logHMM(
                        `📐 HMM(binary) fitted | ` +
                        `A: NR→NR=${(this.hmm.A[0][0] * 100).toFixed(1)}% NR→R=${(this.hmm.A[0][1] * 100).toFixed(1)}% ` +
                        `R→NR=${(this.hmm.A[1][0] * 100).toFixed(1)}% R→R=${(this.hmm.A[1][1] * 100).toFixed(1)}% | ` +
                        `B(rep|NR)=${(fitResult.repeatNR * 100).toFixed(1)}% B(rep|REP)=${(fitResult.repeatREP * 100).toFixed(1)}% | ` +
                        `Discrimination: ${(fitResult.discrimination * 100).toFixed(1)}% ✅`
                    );
                } else {
                    // logHMM(yellow(`⚠️  HMM Baum-Welch rejected: ${fitResult.reason} — using prior params`));
                }
            }
        }

        // ── Viterbi decode ─────────────────────────────────────────────────────
        const vit = this.hmm.viterbi(binaryObs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        // ── Forward (real-time Bayesian posterior) ─────────────────────────────
        // Re-run full forward pass on binary obs for accurate final posterior
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

        // ── Per-digit raw repeat rates ─────────────────────────────────────────
        const rawRepeatProb = this.computePerDigitRepeatRate(window);

        // ── Recent short window repeat rate (last 20 ticks) ───────────────────
        const shortWin = window.slice(-20);
        const shortRepeats = shortWin.slice(1).filter((d, i) => d === shortWin[i]).length;
        const recentRate = (shortRepeats / (shortWin.length - 1)) * 100;

        // ── Lag ACF of recent repeat sequence ─────────────────────────────────
        const acfWindow = this.repeatBuffer.slice(-Math.min(this.repeatBuffer.length, 200));
        const acf = computeACF(acfWindow, 5);

        // ── Structural break test (recent 100 ticks) ──────────────────────────
        const breakBuf = this.repeatBuffer.slice(-100);
        const breakResult = structuralBreakTest(breakBuf);

        // ── BOCPD summary ──────────────────────────────────────────────────────
        const bocpd = this.bocpdResult || { pNonRep: 0.5, expectedRL: 0, modeRL: 0, thetaEstimate: 0.1, pChangepoint: 0.5 };

        // ── EWMA stack ────────────────────────────────────────────────────────
        const ewmaValues = [0, 1, 2, 3].map(i => this.ewma.get(i));
        const ewmaTrend = this.ewma.trend();

        // ── CUSUM results ──────────────────────────────────────────────────────
        const cusumUpAlarm = this.cusum.upAlarm(targetDigit);
        const cusumDownConfirm = this.cusum.downConfirmed(targetDigit);

        // ─────────────────────────────────────────────────────────────────────
        //  ENSEMBLE SCORING (0–100)
        //  Each component votes 0–1, multiplied by its max contribution.
        // ─────────────────────────────────────────────────────────────────────
        const threshold = this.cfg.repeat_threshold;
        const w = this.weights;

        // Component A: BOCPD (25 pts max)
        const bocpdScore = (() => {
            if (!this.bocpd.isNonRepRegime()) return 0;
            const rl = Math.min(bocpd.modeRL, 150) / 150;
            return rl * 25 * w.bocpd;
        })();

        // Component B: HMM Viterbi + persistence (25 pts max)
        const hmmScore = (() => {
            if (vit.currentState !== 0) return 0;
            const persist = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
            const stability = vit.stability;
            const posterior = clamp((posteriorNR - 0.5) / 0.5, 0, 1);
            return ((persist * 0.4 + stability * 0.3 + posterior * 0.3) * 25) * w.hmm;
        })();

        // Component C: EWMA stack (20 pts max)
        const ewmaScore = (() => {
            const allBelow = ewmaValues.every(v => v < threshold);
            if (!allBelow) return 0;
            const trendOk = ewmaTrend <= this.cfg.ewma_trend_threshold;
            const score = allBelow && trendOk ? 1.0 : 0.5;
            const margin = Math.min(...ewmaValues.map(v => Math.max(0, threshold - v))) / threshold;
            return (score * 0.7 + margin * 0.3) * 20 * w.ewma;
        })();

        // Component D: ACF (15 pts max)
        const acfScore = (() => {
            const lag1 = acf[0] ?? 0;
            if (lag1 >= this.cfg.acf_lag1_threshold) return 0;
            const score = clamp(1 - lag1 / this.cfg.acf_lag1_threshold, 0, 1);
            // Bonus for negative ACF (anti-persistence)
            const bonus = lag1 < 0 ? 0.1 : 0;
            return Math.min(1, score + bonus) * 15 * w.acf;
        })();

        // Component E: Structural break (10 pts max)
        const breakScore = (() => {
            if (breakResult.pBreak > this.cfg.structural_break_threshold) return 0;
            return (1 - breakResult.pBreak / this.cfg.structural_break_threshold) * 10 * w.structural;
        })();

        // Component F: CUSUM (5 pts max)
        const cusumScore = (() => {
            if (cusumUpAlarm) return 0;
            const base = 3;
            const bonus = cusumDownConfirm ? 2 : 0;
            return (base + bonus) * w.cusum;
        })();

        let rawScore = bocpdScore + hmmScore + ewmaScore + acfScore + breakScore + cusumScore;

        // Hard gates that zero out score regardless
        if (vit.currentState !== 0) rawScore = 0;
        if (posteriorNR < this.cfg.hmm_nonrep_confidence) rawScore = Math.min(rawScore, 30);
        if (rawRepeatProb[targetDigit] >= threshold) rawScore = 0;
        if (this.ewma.get(0) >= threshold || this.ewma.get(1) >= threshold) rawScore = 0;
        if (cusumUpAlarm) rawScore = 0;
        if (bocpd.pChangepoint > 0.3) rawScore = Math.min(rawScore, 25); // very recent changepoint → uncertain
        if (ewmaTrend > this.cfg.ewma_trend_threshold * 2) rawScore = 0; // sharp upward trend

        const safetyScore = Math.round(clamp(rawScore, 0, 100));

        // ── SIGNAL CONDITION ──────────────────────────────────────────────────
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

            // HMM (Binary)
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            hmmStability: vit.stability,
            posteriorNR,
            posteriorRep,
            hmmA: this.hmm.A,
            hmmB_repeatNR: this.hmm.repeatEmission(0),  // P(repeat | NON-REP state)
            hmmB_repeatREP: this.hmm.repeatEmission(1),  // P(repeat | REP state)
            hmmDiscrim: this.hmm.lastFitDiscrim,

            // BOCPD
            bocpdPNonRep: bocpd.pNonRep,
            bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL,
            bocpdTheta: bocpd.thetaEstimate,
            bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(),

            // EWMA
            ewmaValues,
            ewmaTrend,

            // ACF
            acf,

            // Structural break
            structBreak: breakResult,

            // CUSUM
            cusumUpAlarm,
            cusumDownConfirm,
            cusumUp: this.cusum.upC[targetDigit],
            cusumDown: this.cusum.downC[targetDigit],
            cusumGlobalUp: this.cusum.globalUp,

            // Per-digit rates
            rawRepeatProb,
            recentRate,

            // Component scores
            componentScores: { bocpdScore, hmmScore, ewmaScore, acfScore, breakScore, cusumScore },

            // Composite
            safetyScore,
            signalActive,
        };
    }

    // Feedback: call after a trade resolves to adjust component trust weights
    applyTradeFeedback(won, regime) {
        // Simple adaptive weighting: if a component was saying "safe" but we lost,
        // reduce its weight slightly. Restore over time.
        if (!regime || !regime.valid) return;
        const decay = 0.85, restore = 1.02;
        if (!won) {
            // On a loss in a "safe" signal, slightly distrust components that voted high
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.max(0.5, this.weights[key] * decay);
        } else {
            // On a win, restore weights toward 1.0
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.min(1.0, this.weights[key] * restore);
        }
    }

    resetCUSUM(digit) {
        this.cusum.resetDigit(digit);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
//  Saves/restores session progress across restarts (≤30 min tolerance).
//  Only persists trading stats + per-asset tick histories.
//  Regime detector state is NOT serialised — detectors warm up from history.
// ══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'romanian-ghost-bot-v5-state.json');
const STATE_MAX_AGE_MS = 30 * 60 * 1000;   // 30 minutes
const STATE_SAVE_INTERVAL = 5_000;             // auto-save every 5 s

class StatePersistence {
    static save(bot) {
        try {
            const payload = {
                savedAt: Date.now(),
                trading: {
                    sessionProfit: bot.sessionProfit,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    martingaleStep: bot.martingaleStep,
                    totalMartingaleLoss: bot.totalMartingaleLoss,
                    currentStake: bot.currentStake,
                    currentWinStreak: bot.currentWinStreak,
                    currentLossStreak: bot.currentLossStreak,
                    maxWinStreak: bot.maxWinStreak,
                    maxLossStreak: bot.maxLossStreak,
                    maxMartingaleReached: bot.maxMartingaleReached,
                    largestWin: bot.largestWin,
                    largestLoss: bot.largestLoss,
                },
                // Save last 1 ticks per asset (enough to warm detectors quickly)
                // assets: Object.fromEntries(
                //     Object.entries(bot.channels).map(([sym, ch]) => [sym, {
                //         tickHistory: ch.tickHistory.slice(-1),
                //     }])
                // ),
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(payload));
        } catch (e) {
            logError(`StatePersistence.save: ${e.message}`);
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                logBot('📂 No previous state — starting fresh.');
                return null;
            }
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMs = Date.now() - data.savedAt;
            if (ageMs > STATE_MAX_AGE_MS) {
                logBot(`⚠️  State is ${(ageMs / 60000).toFixed(1)} min old — too stale, starting fresh.`);
                fs.unlinkSync(STATE_FILE);
                return null;
            }
            logBot(`📂 Restoring state from ${(ageMs / 1000).toFixed(0)}s ago...`);
            return data;
        } catch (e) {
            logError(`StatePersistence.load: ${e.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => StatePersistence.save(bot), STATE_SAVE_INTERVAL);
        logBot('🔄 Auto-save started (every 5s).');
    }

    static clear() {
        try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) { }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ASSET CHANNEL
//  Each asset gets its own tick history, prevDigit pointer, and a fully
//  independent AdvancedRegimeDetector instance (separate HMM, BOCPD, CUSUM…).
//  The channel also maintains the per-asset signal/ghost state that was
//  previously held directly on the bot.
// ══════════════════════════════════════════════════════════════════════════════
const CHANNEL_STATE = {
    COLLECTING: 'COLLECTING',
    ANALYZING: 'ANALYZING',
    GHOST_TRADING: 'GHOST_TRADING',
    LOCKED: 'LOCKED',   // trade placed, waiting for result
};

class AssetChannel {
    constructor(symbol, config) {
        this.symbol = symbol;
        this.config = config;
        this.state = CHANNEL_STATE.COLLECTING;
        this.detector = new AdvancedRegimeDetector(config);

        this.tickHistory = [];
        this.prevDigit = -1;

        this.regime = null;
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;

        // Ghost sub-state
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;
    }

    // Called for every new digit that arrives for this asset
    onDigit(curDigit) {
        const prevDigit = this.prevDigit;
        this.tickHistory.push(curDigit);
        if (this.tickHistory.length > this.config.tick_history_size)
            this.tickHistory.shift();
        if (prevDigit >= 0) this.detector.tick(prevDigit, curDigit);
        this.prevDigit = curDigit;
    }

    // Full analysis pass — returns regime result
    analyze(forDigit) {
        this.regime = this.detector.analyze(this.tickHistory, forDigit);
        return this.regime;
    }

    applySignal(digit) {
        this.targetDigit = digit;
        if (!this.regime || !this.regime.valid) { this.signalActive = false; return; }
        this.targetRepeatRate = this.regime.rawRepeatProb[digit];
        this.signalActive = this.regime.signalActive;
    }

    refreshSignal() {
        if (this.targetDigit < 0 || !this.regime || !this.regime.valid) return;
        this.targetRepeatRate = this.regime.rawRepeatProb[this.targetDigit];
        this.signalActive = this.regime.signalActive;
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;
        this.targetDigit = -1;
        this.signalActive = false;
    }

    warmUp(history) {
        this.tickHistory = history.slice(-this.config.tick_history_size);
        for (let i = 1; i < this.tickHistory.length; i++)
            this.detector.tick(this.tickHistory[i - 1], this.tickHistory[i]);
        this.prevDigit = this.tickHistory[this.tickHistory.length - 1] ?? -1;
        this.state = this.tickHistory.length >= this.config.min_ticks_for_analysis
            ? CHANNEL_STATE.ANALYZING : CHANNEL_STATE.COLLECTING;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // ── Assets to monitor simultaneously ─────────────────────────────────
        symbols: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBEAR', 'RDBULL'],

        // ── History ───────────────────────────────────────────────────────────
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

        // ── BOCPD ─────────────────────────────────────────────────────────────
        bocpd_hazard: 1 / 150,
        bocpd_prior_alpha: 1,
        bocpd_prior_beta: 9,
        bocpd_min_run_for_signal: 15,

        // ── HMM ──────────────────────────────────────────────────────────────
        hmm_refit_every: 50,
        hmm_min_discrimination: 0.10,

        // ── Ensemble ─────────────────────────────────────────────────────────
        repeat_confidence: 70,

        // ── Ghost ────────────────────────────────────────────────────────────
        ghost_enabled: false,
        ghost_wins_required: 1,
        ghost_max_rounds: 20000000000,

        // ── Martingale ────────────────────────────────────────────────────────
        martingale_enabled: true,
        martingale_multiplier: 11.3,
        max_martingale_steps: 3,

        // ── Risk ─────────────────────────────────────────────────────────────
        base_stake: 0.61,
        take_profit: 100,
        stop_loss: 70,
        max_stake: 500,
        delay_between_trades: 1500,
        cooldown_after_max_loss: 30000,

        // ── Reconnect ────────────────────────────────────────────────────────
        max_reconnect_attempts: 50,
        reconnect_base_delay: 5000,   // ms — doubles each attempt, max 30s
    };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-ASSET ROMANIAN GHOST BOT v4.0
// ══════════════════════════════════════════════════════════════════════════════
class RomanianGhostBotV4 {
    constructor(config) {
        this.config = config;

        // ── WebSocket ─────────────────────────────────────────────────────────
        this.ws = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.reconnectTimer = null;
        this.pingInterval = null;
        this.dataWatchdog = null;
        this.lastDataTime = Date.now();
        this.requestId = 0;

        // ── Account ───────────────────────────────────────────────────────────
        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';

        // ── Per-asset channels ────────────────────────────────────────────────
        // Each symbol gets a fully independent AssetChannel (detector, history…)
        this.channels = Object.fromEntries(
            config.symbols.map(sym => [sym, new AssetChannel(sym, config)])
        );
        // Track which channels have finished loading history
        this.channelsReady = new Set();

        // ── Shared trading state (only ONE trade across all assets at a time) ─
        this.activeChannel = null;   // AssetChannel currently in a trade
        this.isTradeActive = false;
        this.pendingTrade = false;
        this.lastContractId = null;
        this.lastBuyPrice = 0;

        // ── Session stats ─────────────────────────────────────────────────────
        this.sessionStartTime = Date.now();
        this.sessionProfit = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = config.base_stake;
        this.currentWinStreak = 0;
        this.currentLossStreak = 0;
        this.maxWinStreak = 0;
        this.maxLossStreak = 0;
        this.maxMartingaleReached = 0;
        this.largestWin = 0;
        this.largestLoss = 0;

        this.cooldownTimer = null;

        // ── Telegram ─────────────────────────────────────────────────────────
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // ── Load persisted state if available ─────────────────────────────────
        this._loadPersistedState();
    }

    _loadPersistedState() {
        const saved = StatePersistence.load();
        if (!saved) return;
        try {
            const t = saved.trading;
            this.sessionProfit = t.sessionProfit;
            this.totalTrades = t.totalTrades;
            this.totalWins = t.totalWins;
            this.totalLosses = t.totalLosses;
            this.martingaleStep = t.martingaleStep;
            this.totalMartingaleLoss = t.totalMartingaleLoss;
            this.currentStake = t.currentStake;
            this.currentWinStreak = t.currentWinStreak;
            this.currentLossStreak = t.currentLossStreak;
            this.maxWinStreak = t.maxWinStreak;
            this.maxLossStreak = t.maxLossStreak;
            this.maxMartingaleReached = t.maxMartingaleReached;
            this.largestWin = t.largestWin;
            this.largestLoss = t.largestLoss;

            // Pre-seed tick histories from saved state so warmup is faster
            if (saved.assets) {
                Object.entries(saved.assets).forEach(([sym, data]) => {
                    if (this.channels[sym] && data.tickHistory?.length) {
                        // Channel will still warmup fully from API history,
                        // but having some data helps if API history is short.
                        this.channels[sym].tickHistory = data.tickHistory;
                    }
                });
            }

            logBot(green(`✅ State restored — Trades:${this.totalTrades} W:${this.totalWins} L:${this.totalLosses} P&L:${formatMoney(this.sessionProfit)} Stake:$${this.currentStake.toFixed(2)}`));
        } catch (e) {
            logError(`State restore error: ${e.message}`);
        }
    }

    // ── Entry point ───────────────────────────────────────────────────────────
    start() {
        this.printBanner();
        StatePersistence.startAutoSave(this);
        this.connectWS();
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v4.0  —  Multi-Asset Precision Regime Detect')));
        console.log(bold(cyan('   BOCPD + BinaryHMM + EWMA Stack + ACF + Structural Break + CUSUM     ')));
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════════')));
        console.log(`  Assets              : ${bold(c.symbols.join(', '))}`);
        console.log(`  Base Stake          : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Repeat Threshold    : ${bold(c.repeat_threshold + '%')}`);
        console.log(`  HMM NonRep Conf     : ${bold((c.hmm_nonrep_confidence * 100).toFixed(0) + '%')}`);
        console.log(`  BOCPD NonRep Conf   : ${bold((c.bocpd_nonrep_confidence * 100).toFixed(0) + '%')} | Hazard: 1/${Math.round(1 / c.bocpd_hazard)}t`);
        console.log(`  Min Persistence     : ${bold(c.min_regime_persistence)} ticks`);
        console.log(`  Ensemble Score Gate : ${bold(c.repeat_confidence + '/100')}`);
        console.log(`  Ghost Trading       : ${c.ghost_enabled ? green('ON') + ` | Wins: ${c.ghost_wins_required}` : red('OFF')}`);
        console.log(`  Martingale          : ${c.martingale_enabled ? green('ON') + ` | Steps: ${c.max_martingale_steps} | Mult: ${c.martingale_multiplier}x` : red('OFF')}`);
        console.log(`  Take Profit         : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss           : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(`  State Persistence   : ${green('ON')} — ${STATE_FILE}`);
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════════')));
        console.log('');
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connectWS() {
        this.botState = STATE.CONNECTING;
        if (this.isReconnecting) {
            logApi(yellow('Reconnect already in progress, skipping...'));
            return;
        }
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting → ${dim(url)}`);
        try { this.ws = new WebSocket(url); } catch (e) {
            logError(`WS create failed: ${e.message}`); this.scheduleReconnect(); return;
        }

        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.lastDataTime = Date.now();
            this.botState = STATE.AUTHENTICATING;
            this._startPing();
            this._startDataWatchdog();
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            this.lastDataTime = Date.now();
            try { this.handleMessage(JSON.parse(raw)); } catch (e) { logError(`Parse: ${e.message}`); }
        });

        this.ws.on('pong', () => { this.lastDataTime = Date.now(); });

        this.ws.on('close', code => {
            logApi(yellow(`⚠️  WebSocket closed (${code})`));
            this._stopPing(); this._stopDataWatchdog();
            if (this.botState !== STATE.STOPPED) this.scheduleReconnect();
        });

        this.ws.on('error', e => logError(`WS error: ${e.message}`));
    }

    scheduleReconnect() {
        if (this.botState === STATE.STOPPED) return;
        if (this.isReconnecting) return;
        if (this.reconnectAttempts >= this.config.max_reconnect_attempts) {
            logError('Max reconnect attempts reached — giving up.');
            this.sendTelegram('❌ <b>Max reconnect attempts reached. Bot stopped.</b>');
            this.stop('Max reconnects exceeded');
            return;
        }
        this.isReconnecting = true;
        this.reconnectAttempts++;
        // Exponential backoff capped at 30s
        const delay = Math.min(
            this.config.reconnect_base_delay * Math.pow(1.5, this.reconnectAttempts - 1),
            30_000
        );
        logApi(`Reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.config.max_reconnect_attempts})...`);
        StatePersistence.save(this);
        this.sendTelegram(
            `⚠️ <b>CONNECTION LOST</b>\nAttempt ${this.reconnectAttempts}/${this.config.max_reconnect_attempts}\n` +
            `Retrying in ${(delay / 1000).toFixed(1)}s — P&L: ${formatMoney(this.sessionProfit)}`
        );
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connectWS();
        }, delay);
    }

    _startPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, 20_000);
    }
    _stopPing() { if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; } }

    // Data watchdog: force reconnect if no messages in 60s
    _startDataWatchdog() {
        if (this.dataWatchdog) clearInterval(this.dataWatchdog);
        this.dataWatchdog = setInterval(() => {
            const silence = Date.now() - this.lastDataTime;
            if (silence > 60_000) {
                logError(`No data for ${(silence / 1000).toFixed(0)}s — forcing reconnect.`);
                StatePersistence.save(this);
                this.ws?.terminate();
            }
        }, 10_000);
    }
    _stopDataWatchdog() { if (this.dataWatchdog) { clearInterval(this.dataWatchdog); this.dataWatchdog = null; } }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); } catch (e) { logError(`Send: ${e.message}`); }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }).catch(() => { });
    }

    // ── Message dispatch ──────────────────────────────────────────────────────
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
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown';
        logError(`[${code}] on ${msg.msg_type || '?'}: ${emsg}`);
        if (['InvalidToken', 'AuthorizationRequired'].includes(code)) { this.stop('Auth failed'); return; }
        if (code === 'RateLimit') setTimeout(() => { this.isTradeActive = false; }, 10_000);
        if (code === 'InsufficientBalance') { this.stop('Insufficient balance'); return; }
        if (msg.msg_type === 'buy') { this.isTradeActive = false; this.activeChannel = null; }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Auth OK')} | ${bold(this.accountId)} ${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | Bal: ${green('$' + this.accountBalance.toFixed(2))}`);
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT — trading with real money!');

        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.botState = STATE.COLLECTING_TICKS;

        // Request history + subscribe live ticks for every asset
        for (const sym of this.config.symbols) {
            logBot(`Fetching ${bold(this.config.tick_history_size)} ticks for ${bold(sym)}...`);
            this.send({
                ticks_history: sym,
                count: this.config.tick_history_size,
                end: 'latest',
                style: 'ticks',
            });
            this.send({ ticks: sym, subscribe: 1 });
        }
    }

    handleTickHistory(msg) {
        const sym = msg.echo_req?.ticks_history;
        if (!sym || !this.channels[sym]) return;
        const ch = this.channels[sym];
        if (!msg.history?.prices) { logError(`No history for ${sym}`); return; }

        const digits = msg.history.prices.map(p => getLastDigit(p, sym));
        logBot(`${green('✅')} ${bold(sym)}: loaded ${digits.length} ticks — warming up detector...`);
        ch.warmUp(digits);
        logBocpd(`${sym} after warmup | P(NR)=${(ch.detector.bocpd.pNonRep * 100).toFixed(1)}% | EWMA[1]=${ch.detector.ewma.get(1).toFixed(1)}%`);

        this.channelsReady.add(sym);
        const readyCount = this.channelsReady.size;
        const totalCount = this.config.symbols.length;
        logBot(`Channels ready: ${readyCount}/${totalCount}`);

        if (readyCount === totalCount) {
            logBot(green(bold('✅ All channels ready — beginning multi-asset analysis.')));
            this.botState = STATE.ANALYZING;
        }
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    // ── Core tick handler — dispatches to the right channel ───────────────────
    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;
        const sym = msg.tick.symbol;
        const ch = this.channels[sym];
        if (!ch) return;

        const price = msg.tick.quote;
        const curDigit = getLastDigit(price, sym);

        ch.onDigit(curDigit);

        // Quiet log every 5 ticks per asset to keep console readable
        const count = ch.tickHistory.length;
        const last4 = ch.tickHistory.slice(Math.max(0, count - 5), count - 1).join(' › ');
        logTick(`${dim(sym)} ${dim(last4 + ' ›')} ${bold(cyan('[' + curDigit + ']'))} ${dim(price)} (${count})`);

        // If channel isn't ready yet, just accumulate
        if (ch.state === CHANNEL_STATE.COLLECTING) {
            if (count >= this.config.min_ticks_for_analysis) {
                ch.state = CHANNEL_STATE.ANALYZING;
                this.channelsReady.add(sym);
            }
            return;
        }

        // If this channel is locked (trade in progress on it), just accumulate ticks
        if (ch.state === CHANNEL_STATE.LOCKED) return;

        // If another channel currently has a live trade, analyze but don't trade
        if (this.isTradeActive && this.activeChannel !== ch) {
            ch.analyze(curDigit);
            ch.applySignal(curDigit);
            return;
        }

        // ── Full analysis + signal check ───────────────────────────────────────
        if (this.botState === STATE.STOPPED || this.botState === STATE.COOLDOWN) return;

        ch.analyze(curDigit);
        ch.applySignal(curDigit);
        this.logChannelAnalysis(ch, curDigit);

        if (ch.state === CHANNEL_STATE.GHOST_TRADING) {
            ch.analyze(curDigit);     // re-analyze with locked target
            ch.refreshSignal();
            this.runGhostCheck(ch, curDigit);
            return;
        }

        if (ch.state === CHANNEL_STATE.ANALYZING && ch.signalActive && !this.isTradeActive) {
            this.processSignal(ch, curDigit);
        }
    }

    // ── Signal → ghost or trade ───────────────────────────────────────────────
    processSignal(ch, curDigit) {
        if (!ch.signalActive) { ch.state = CHANNEL_STATE.ANALYZING; return; }
        if (this.config.ghost_enabled && !ch.ghostConfirmed) {
            ch.state = CHANNEL_STATE.GHOST_TRADING;
            logGhost(`👻 [${ch.symbol}] Ghost phase. Target: ${bold(cyan(ch.targetDigit))} | Score:${ch.regime.safetyScore}/100 | Need ${this.config.ghost_wins_required} wins.`);
            this.runGhostCheck(ch, curDigit);
        } else {
            this.executeTradeFlow(ch);
        }
    }

    runGhostCheck(ch, curDigit) {
        if (ch.state !== CHANNEL_STATE.GHOST_TRADING) return;
        if (!ch.signalActive) {
            logGhost(dim(`[${ch.symbol}] Signal lost — back to ANALYZING`));
            ch.resetGhost(); ch.state = CHANNEL_STATE.ANALYZING; return;
        }

        ch.ghostRoundsPlayed++;
        if (ch.ghostAwaitingResult) {
            ch.ghostAwaitingResult = false;
            if (curDigit !== ch.targetDigit) {
                ch.ghostConsecutiveWins++;
                logGhost(`👻 [${ch.symbol}] ${green('✅ Ghost WIN ' + ch.ghostConsecutiveWins + '/' + this.config.ghost_wins_required)}`);
            } else {
                logGhost(`👻 [${ch.symbol}] ${red('❌ Ghost LOSS — digit REPEATED')} (had ${ch.ghostConsecutiveWins} wins) — reset`);
                ch.ghostConsecutiveWins = 0;
            }
        } else {
            if (curDigit === ch.targetDigit) {
                const wic = ch.ghostConsecutiveWins + 1;
                if (wic >= this.config.ghost_wins_required) {
                    ch.ghostConsecutiveWins = wic; ch.ghostConfirmed = true;
                    logGhost(green(bold(`[${ch.symbol}] ✅ Ghost confirmed! Live trade NOW.`)));
                    this.executeTradeFlow(ch);
                } else {
                    ch.ghostAwaitingResult = true;
                    logGhost(`👻 [${ch.symbol}] Digit ${cyan(ch.targetDigit)} appeared | ${ch.ghostConsecutiveWins}/${this.config.ghost_wins_required} | awaiting...`);
                }
            } else {
                logGhost(dim(`[${ch.symbol}] ⏳ Digit ${curDigit} — waiting for ${ch.targetDigit}`));
                ch.refreshSignal();
                if (!ch.signalActive) { ch.resetGhost(); ch.state = CHANNEL_STATE.ANALYZING; }
            }
        }

        if (!ch.ghostConfirmed && ch.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`[${ch.symbol}] Max ghost rounds — re-analyzing.`));
            ch.resetGhost(); ch.state = CHANNEL_STATE.ANALYZING;
        }
    }

    // ── Trade execution ───────────────────────────────────────────────────────
    executeTradeFlow(ch) {
        if (this.isTradeActive || this.botState === STATE.STOPPED) return;
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(`[${ch.symbol}] ${risk.reason}`);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
            return;
        }
        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake) { this.stop('Stake exceeds max'); return; }
        if (this.currentStake > this.accountBalance) { this.stop('Insufficient balance'); return; }
        this.placeTrade(ch);
    }

    placeTrade(ch) {
        this.isTradeActive = true;
        this.activeChannel = ch;
        ch.state = CHANNEL_STATE.LOCKED;
        this.botState = STATE.PLACING_TRADE;

        const r = ch.regime;
        const score = r?.valid ? r.safetyScore : 0;
        const pnr = r?.valid ? (r.posteriorNR * 100).toFixed(1) + '%' : '?';
        const bRL = r?.valid ? r.bocpdModeRL : '?';
        const step = this.config.martingale_enabled ? ` | Mart:${this.martingaleStep}/${this.config.max_martingale_steps}` : '';

        logTrade(`🎯 [${bold(ch.symbol)}] DIFFER from ${bold(cyan(ch.targetDigit))} | Stake:${bold('$' + this.currentStake.toFixed(2))}${step} | Rate:${ch.targetRepeatRate.toFixed(1)}% | Score:${score}/100 | P(NR):${pnr} | BOCPD_RL:${bRL}t`);

        this.sendTelegram(
            `🎯 <b>mTRADE — ${ch.symbol}</b>
            📊 Digit: ${ch.targetDigit} | Rate: ${ch.targetRepeatRate.toFixed(1)}%
            🔢 Last10: ${ch.tickHistory.slice(-10).join(',')}
            💰 Stake: $${this.currentStake.toFixed(2)}${step}
            🔬 Score: ${score}/100 | P(NR): ${pnr} 
            📊 BOCPD_RL: ${bRL}t
            👻 Ghost: ${ch.ghostConsecutiveWins}/${this.config.ghost_wins_required}
         `
        );

        this.send({
            buy: 1, price: this.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: ch.symbol,
                duration: 1, duration_unit: 't',
                basis: 'stake',
                amount: this.currentStake,
                barrier: String(ch.targetDigit),
                currency: this.config.currency,
            },
        });
        this.botState = STATE.WAITING_RESULT;
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        logTrade(dim(`Contract ${this.lastContractId} | Cost:$${this.lastBuyPrice.toFixed(2)} | Payout:$${parseFloat(msg.buy.payout).toFixed(2)}`));
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;
        this.botState = STATE.PROCESSING_RESULT;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;
        const ch = this.activeChannel;
        const resultDigit = ch?.tickHistory.at(-1) ?? null;
        const won = profit > 0;

        if (won) this.processWin(profit, resultDigit, ch);
        else this.processLoss(this.lastBuyPrice, resultDigit, ch);

        if (ch) ch.detector.applyTradeFeedback(won, ch.regime);
        StatePersistence.save(this);

        this.isTradeActive = false;
        this.activeChannel = null;
        this.decideNextAction(ch, won);
    }

    processWin(profit, resultDigit, ch) {
        this.totalWins++; this.sessionProfit += profit;
        this.currentWinStreak++; this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;

        // Save trade data BEFORE resetting
        const tradeTargetDigit = ch?.targetDigit;
        const tradeTickHistory = ch ? [...ch.tickHistory] : [];

        if (ch) { ch.detector.resetCUSUM(ch.targetDigit); ch.resetGhost(); ch.state = CHANNEL_STATE.ANALYZING; }
        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${green('✅ WIN!')} [${ch?.symbol}] +$${profit.toFixed(2)} | P/L:${plStr} | Bal:$${this.accountBalance.toFixed(2)}`);
        if (resultDigit !== null) logResult(dim(`  Target:${tradeTargetDigit} Result:${resultDigit}`));
        
        this.sendTelegram(`
            ✅ mWIN! [${ch?.symbol}]
            🔢 Target:${tradeTargetDigit} | Result:${resultDigit} 
            📊 Last10: ${tradeTickHistory.slice(-10).join(',')}  
            💰 $${profit.toFixed(2)} 
            📊 P&L: ${formatMoney(this.sessionProfit)}
            📊 ${this.totalWins}W/${this.totalLosses}L
        `);
        this.resetMartingale();
    }

    processLoss(lostAmount, resultDigit, ch) {
        this.totalLosses++; this.sessionProfit -= lostAmount; this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++; this.currentWinStreak = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

        // Save trade data BEFORE resetting
        const tradeTargetDigit = ch?.targetDigit;
        const tradeTickHistory = ch ? [...ch.tickHistory] : [];

        if (ch) { ch.ghostConsecutiveWins = 0; ch.ghostConfirmed = false; ch.ghostRoundsPlayed = 0; ch.ghostAwaitingResult = false; ch.state = CHANNEL_STATE.ANALYZING; }
        const step = this.config.martingale_enabled ? ` | Mart:${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${red('❌ LOSS!')} [${ch?.symbol}] -$${lostAmount.toFixed(2)} | P/L:${plStr}${step}`);
        if (resultDigit !== null) logResult(dim(`  Target:${tradeTargetDigit} Result:${resultDigit} ${resultDigit === tradeTargetDigit ? red('REPEATED') : green('diff — unexpected')}`));
        this.sendTelegram(`
            ❌ <b>mLOSS! [${ch?.symbol}]</b>
            🔢 Target:${tradeTargetDigit} | Result:${resultDigit}  
            📊 Last10: ${tradeTickHistory.slice(-10).join(',')} 
            💸 -$${lostAmount.toFixed(2)} 
            📊 P&L: ${formatMoney(this.sessionProfit)}
            📊 ${this.totalWins}W/${this.totalLosses}L${step}
        `);
    }

    decideNextAction(ch, won) {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }
        if (this.config.martingale_enabled && this.martingaleStep > 0 && this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`📈 Martingale recovery step ${this.martingaleStep}/${this.config.max_martingale_steps}...`));
            this.botState = STATE.ANALYZING;
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk('🛑 Max Martingale steps reached!'); this.resetMartingale(); this.startCooldown(); return;
        }
        this.botState = STATE.ANALYZING;
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
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nP&L: ${formatMoney(this.sessionProfit)}\n${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🎯 Take profit! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\nP&L: ${formatMoney(this.sessionProfit)}\n${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🛑 Stop loss! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const ns = this.calculateStake();
        if (ns > this.accountBalance) return { canTrade: false, reason: 'Next stake > balance', action: 'STOP' };
        if (ns > this.config.max_stake) return { canTrade: false, reason: 'Next stake > max', action: 'STOP' };
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: 'Max Martingale steps reached.', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    resetMartingale() { this.martingaleStep = 0; this.totalMartingaleLoss = 0; this.currentStake = this.config.base_stake; }

    startCooldown() {
        this.botState = STATE.COOLDOWN;
        this.resetMartingale();
        Object.values(this.channels).forEach(ch => ch.resetGhost());
        logBot(`⏸️  Cooldown ${this.config.cooldown_after_max_loss / 1000}s...`);
        this.cooldownTimer = setTimeout(() => {
            if (this.botState === STATE.COOLDOWN) {
                logBot(green('▶️  Cooldown ended. Resuming...'));
                this.botState = STATE.ANALYZING;
            }
        }, this.config.cooldown_after_max_loss);
    }

    // ── Logging helpers ───────────────────────────────────────────────────────
    logChannelAnalysis(ch, curDigit) {
        if (!ch.regime || !ch.regime.valid) return;
        const r = ch.regime;
        const thr = this.config.repeat_threshold;
        const sym = ch.symbol;

        const rateStr = r.rawRepeatProb.map((rp, i) => {
            if (i === curDigit) return (rp < thr ? green : red)(`${i}:${rp.toFixed(0)}%`);
            return dim(`${i}:${rp.toFixed(0)}%`);
        }).join(' ');
        // logAnalysis(`[${sym}] Rates: [${rateStr}] recent=${r.recentRate.toFixed(1)}%`);

        const stateCol = r.hmmState === 0 ? green : yellow;
        const pnrPct = (r.posteriorNR * 100).toFixed(1);
        // logHMM(`[${sym}] HMM: ${stateCol(bold(r.hmmStateName))} | P(NR):${r.posteriorNR >= this.config.hmm_nonrep_confidence ? green(pnrPct + '%') : red(pnrPct + '%')} | Persist:${r.hmmPersistence >= this.config.min_regime_persistence ? green(r.hmmPersistence + 't') : yellow(r.hmmPersistence + 't')} | B(rep|NR)=${(r.hmmB_repeatNR * 100).toFixed(1)}% B(rep|REP)=${(r.hmmB_repeatREP * 100).toFixed(1)}% Discrim:${(r.hmmDiscrim * 100).toFixed(1)}%`);

        const bocpdOk = r.bocpdIsNonRep && r.bocpdPNonRep >= this.config.bocpd_nonrep_confidence;
        // logBocpd(`[${sym}] BOCPD: P(NR):${bocpdOk ? green((r.bocpdPNonRep * 100).toFixed(1) + '%') : red((r.bocpdPNonRep * 100).toFixed(1) + '%')} | ModeRL:${r.bocpdModeRL >= this.config.bocpd_min_run_for_signal ? green(r.bocpdModeRL + 't') : yellow(r.bocpdModeRL + 't')} | ExpRL:${r.bocpdExpRL.toFixed(1)}t | θ̂:${(r.bocpdTheta * 100).toFixed(1)}%`);

        // logAnalysis(`[${sym}] EWMA:${r.ewmaValues.map((v, i) => v < thr ? green(v.toFixed(1) + '%') : red(v.toFixed(1) + '%')).join('|')} Trend:${r.ewmaTrend <= this.config.ewma_trend_threshold ? green(r.ewmaTrend.toFixed(2) + '%') : red(r.ewmaTrend.toFixed(2) + '%')} ACF[1]:${r.acf[0] < this.config.acf_lag1_threshold ? green(r.acf[0].toFixed(3)) : red(r.acf[0].toFixed(3))}`);
        // logAnalysis(`[${sym}] CUSUM:up=${r.cusumUpAlarm ? red('ALARM ' + r.cusumUp.toFixed(2)) : green('ok ' + r.cusumUp.toFixed(2))} down=${r.cusumDownConfirm ? green('confirmed ' + r.cusumDown.toFixed(2)) : dim('pending ' + r.cusumDown.toFixed(2))} | Break:p=${r.structBreak.pBreak.toFixed(3)} ${r.structBreak.pBreak > this.config.structural_break_threshold ? red('BREAK') : green('OK')}`);

        const cs = r.componentScores;
        // logRegime(`[${sym}] Score:${r.safetyScore >= this.config.repeat_confidence ? green(bold(r.safetyScore + '/100')) : red(r.safetyScore + '/100')} | BOCPD:${cs.bocpdScore.toFixed(1)} HMM:${cs.hmmScore.toFixed(1)} EWMA:${cs.ewmaScore.toFixed(1)} ACF:${cs.acfScore.toFixed(1)} Break:${cs.breakScore.toFixed(1)} CUSUM:${cs.cusumScore.toFixed(1)}`);

        if (ch.signalActive) {
            logAnalysis(green(bold(`✅ [${sym}] SIGNAL ACTIVE — digit ${curDigit} | Score:${r.safetyScore}/100 | P(NR):${pnrPct}% → DIFFER`)));
        } else {
            const reasons = [];
            if (r.hmmState !== 0) reasons.push(`HMM=${r.hmmStateName}`);
            if (r.posteriorNR < this.config.hmm_nonrep_confidence) reasons.push(`P(NR)=${pnrPct}%`);
            if (r.hmmPersistence < this.config.min_regime_persistence) reasons.push(`persist=${r.hmmPersistence}<${this.config.min_regime_persistence}`);
            if (!r.bocpdIsNonRep) reasons.push(`BOCPD:not_NR(RL=${r.bocpdModeRL}t)`);
            if (r.bocpdPNonRep < this.config.bocpd_nonrep_confidence) reasons.push(`BOCPD_P(NR)=${(r.bocpdPNonRep * 100).toFixed(1)}%`);
            if (r.rawRepeatProb[curDigit] >= thr) reasons.push(`raw=${r.rawRepeatProb[curDigit].toFixed(1)}%`);
            if (ch.detector.ewma.get(0) >= thr || ch.detector.ewma.get(1) >= thr) reasons.push(`EWMA_high`);
            if (r.ewmaTrend > this.config.ewma_trend_threshold) reasons.push(`trend+${r.ewmaTrend.toFixed(2)}`);
            if (r.acf[0] >= this.config.acf_lag1_threshold) reasons.push(`ACF[1]=${r.acf[0].toFixed(3)}`);
            if (r.cusumUpAlarm) reasons.push(`CUSUM_UP_ALARM`);
            if (r.structBreak.pBreak >= this.config.structural_break_threshold) reasons.push(`STRUCT_BREAK(p=${r.structBreak.pBreak.toFixed(2)})`);
            if (r.safetyScore < this.config.repeat_confidence) reasons.push(`score=${r.safetyScore}<${this.config.repeat_confidence}`);
            // logAnalysis(red(`⛔ NO SIGNAL [${sym}] digit ${curDigit}: ${reasons.join(', ')}`));
        }
    }

    // ── Stop / final stats ────────────────────────────────────────────────────
    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping.')} Reason: ${reason}`);
        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this._stopPing(); this._stopDataWatchdog();
        StatePersistence.save(this);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) { }
            setTimeout(() => { try { this.ws.close(); } catch (_) { } }, 500);
        }

        this.sendTelegram(`🛑 <b>STOPPED</b>\nReason: ${reason}\nP&L: ${formatMoney(this.sessionProfit)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('════════════════════════════════════════════════')));
        logStats(bold(cyan('           SESSION SUMMARY (v4.0)              ')));
        logStats(bold(cyan('════════════════════════════════════════════════')));
        logStats(`  Assets           : ${bold(this.config.symbols.join(', '))}`);
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
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
        logStats(bold(cyan('════════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ───────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();
    const bot = new RomanianGhostBotV4(config);
    process.on('SIGINT', () => { console.log(''); bot.stop('SIGINT'); });
    process.on('SIGTERM', () => bot.stop('SIGTERM'));
    process.on('uncaughtException', e => {
        logError(`Uncaught: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', r => logError(`Rejection: ${r}`));
    bot.start();
})();
