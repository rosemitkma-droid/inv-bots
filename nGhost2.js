#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v3.0 Ultra-Advanced Regime Detection
//  Deriv Digit Differ — HSMM + BOCPD + Shannon Entropy + Bayesian
//
//  UPGRADED REGIME ENGINE v3.0:
//    1. True 2-State HMM with Duration-Penalised Viterbi (HSMM-style)
//       — Learns sojourn-time Poisson distributions per state via Baum-Welch
//       — Penalises Viterbi transitions when expected sojourn not expired
//    2. Baum-Welch parameter estimation (learns emission probs from data)
//    3. Bayesian Online Change-Point Detection (BOCPD) with
//       Dirichlet-Multinomial conjugate — replaces CUSUM entirely.
//       Maintains run-length posterior P(r_t | x_{1..t}) updated each tick.
//       Alarm fires only when P(run_length > 15 ticks) < 0.95.
//    4. Shannon Entropy filter — information-theoretic regime gate.
//       H(X) on last 30 ticks (max = log2(10) ≈ 3.32 bits).
//       H > 3.1 → regime is safely random → boost safetyScore.
//       H < 2.8 → digits are clumping → zero safetyScore immediately.
//    5. Forward algorithm for real-time regime probability updates
//    6. Per-digit conditional emission model (not global)
//    7. Regime persistence scoring (how stable is the current regime)
//
//  TRADE CONDITION: Only fire when ALL hold:
//    a) HSMM Viterbi → current regime = NON-REP (high confidence)
//    b) Bayesian posterior P(NON-REP | observations) ≥ 0.85
//    c) BOCPD P(run_length > 15) ≥ 0.95 (stable, confirmed regime)
//    d) Shannon entropy H ≥ 2.8 bits (market is genuinely random)
//    e) Per-digit conditional repeat prob < threshold
//    f) Regime persistence score ≥ min_persistence ticks
//
//  Usage:
//    node romanian-ghost-bot-v3.js --token YOUR_DERIV_API_TOKEN [options]
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

// ── ANSI Colour Helpers ───────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m', white: '\x1b[37m',
};
const col = (text, ...codes) => codes.join('') + text + C.reset;
const bold = t => col(t, C.bold);
const dim = t => col(t, C.dim);
const cyan = t => col(t, C.cyan);
const blue = t => col(t, C.blue);
const green = t => col(t, C.green);
const red = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta = t => col(t, C.magenta);

// ── Logger ─────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: cyan, API: blue, TICK: dim, ANALYSIS: yellow,
    GHOST: magenta, TRADE: bold, RESULT: bold, RISK: red,
    STATS: cyan, ERROR: t => col(t, C.bold, C.red), HMM: t => col(t, C.orange),
};

function getTimestamp() {
    const n = new Date();
    return [String(n.getHours()).padStart(2,'0'), String(n.getMinutes()).padStart(2,'0'), String(n.getSeconds()).padStart(2,'0')].join(':');
}

function log(prefix, message) {
    const ts = dim(`[${getTimestamp()}]`);
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

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        symbol: 'R_100',
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // History & analysis
        tick_history_size: 300,
        analysis_window: 300,          // HMM training window
        min_ticks_for_hmm: 50,         // Minimum ticks before HMM is reliable

        // BOCPD change-point detection
        // Regime detection thresholds
        repeat_threshold: 8,           // Raw per-digit repeat % gate

        // BOCPD change-point detection (replaces CUSUM)
        bocpd_hazard: 1/50,            // Prior hazard rate (expected regime length ~50 ticks)
        bocpd_alpha0: 1.0,             // Dirichlet prior concentration (flat)
        bocpd_min_run_length: 15,      // Minimum run-length to consider regime stable
        bocpd_run_confidence: 0.95,    // Required P(r_t > min_run_length) to allow trade

        // Shannon Entropy filter (model-free information-theory gate)
        entropy_window: 30,            // Rolling window for entropy computation
        entropy_high: 3.1,             // Above this → genuinely random → boost score
        entropy_low: 2.8,              // Below this → clumping → zero score immediately

        // HSMM sojourn-time priors (Poisson lambda per state, ticks)
        hsmm_mean_duration_nonrep: 25, // Expected NON-REP regime length (ticks)
        hsmm_mean_duration_rep: 15,    // Expected REP regime length (ticks)
        bocpd_alpha0: 1.0,             // Dirichlet prior concentration (flat)
        bocpd_min_run_length: 15,      // Minimum run-length to consider regime stable
        bocpd_run_confidence: 0.85,    // Required P(r_t > min_run_length) to allow trade 95

        // Shannon Entropy filter
        entropy_window: 30,            // Rolling window for entropy computation
        entropy_high: 3.1,             // Above this → genuinely random → boost score
        entropy_low: 2.8,              // Below this → clumping → zero score immediately

        // HSMM sojourn-time priors (Poisson lambda per state, ticks)
        hsmm_mean_duration_nonrep: 25, // Expected NON-REP regime length (ticks)
        hsmm_mean_duration_rep: 15,    // Expected REP regime length (ticks)
        repeat_confidence: 85,        // Bayesian P(repeat | observations) required 98
        hmm_nonrep_confidence: 0.85,   // Bayesian P(NON-REP) required 0.98
        min_regime_persistence: 8,     // Ticks current regime must have lasted

        // Ghost trading
        ghost_enabled: true,
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
    if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}

function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

// ── State Constants ───────────────────────────────────────────────────────────
const STATE = {
    INITIALIZING: 'INITIALIZING', CONNECTING: 'CONNECTING', AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS', ANALYZING: 'ANALYZING', GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE', WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT', COOLDOWN: 'COOLDOWN', STOPPED: 'STOPPED',
};

// ══════════════════════════════════════════════════════════════════════════════
//  ADVANCED REGIME DETECTION ENGINE v3.0
//
//  2-STATE HIDDEN SEMI-MARKOV MODEL (HSMM)
//  ─────────────────────────────────────────
//  States:  S0 = NON-REP  (digit is unlikely to repeat next tick)
//           S1 = REP      (digit is likely to repeat next tick)
//
//  Observations: For a target digit d at tick t, the observable is:
//    o_t = 1 if ticks[t] === ticks[t-1]  (a repeat occurred)
//    o_t = 0 otherwise                    (no repeat)
//
//  Parameters (learned via Baum-Welch on tick history):
//    π  = initial state distribution [P(S0), P(S1)]
//    A  = transition matrix [[P(S0→S0), P(S0→S1)], [P(S1→S0), P(S1→S1)]]
//    B  = emission probs:  B[s][o]
//         B[0][1] = P(repeat | NON-REP state)   (should be low, ~0.05-0.15)
//         B[1][1] = P(repeat | REP state)        (should be high, ~0.5-0.9)
//    D  = sojourn Poisson means [lambda_NR, lambda_REP]
//         Learned from Baum-Welch state occupancy statistics.
//
//  DURATION-PENALISED VITERBI (HSMM-style)
//  ─────────────────────────────────────────
//  Standard Viterbi is extended with a log-duration penalty:
//    logDurationPenalty(state, run_length) =
//      Poisson.logPMF(run_length, D[state])
//  Applied whenever Viterbi stays in the same state. This causes the decoder
//  to naturally predict a regime flip when the regime has exceeded its
//  learned typical lifetime.
//
//  BAYESIAN ONLINE CHANGE-POINT DETECTION (BOCPD)
//  ────────────────────────────────────────────────
//  Replaces CUSUM. Maintains a run-length posterior P(r_t | x_{1..t})
//  using a Dirichlet-Multinomial conjugate model for categorical digit data.
//  At each tick, the posterior over all possible run lengths is updated in
//  exact closed form.
//  Alarm fires when: P(r_t > 15 ticks) < 0.95  → regime is too young.
//  Conversely, trade is only allowed when P(r_t > 15 ticks) ≥ 0.95,
//  meaning we are in a confirmed, stable regime with high probability.
//
//  SHANNON ENTROPY FILTER
//  ───────────────────────
//  Model-free gate computed over the last 30 raw digit ticks (0-9).
//    H(X) = -Σ p(x) log2 p(x)   where x ∈ {0..9}
//    Max entropy = log2(10) ≈ 3.32 bits (perfectly uniform digits).
//  H > 3.1 → random market, boost safetyScore.
//  H < 2.8 → clumping/predictability, zero safetyScore immediately.
//
//  FORWARD ALGORITHM (real-time)
//  ──────────────────────────────
//  Incrementally updated on each new tick.
//  Gives P(state=S0 | all observations so far) — Bayesian posterior.
//
//  REGIME PERSISTENCE
//  ───────────────────
//  Count consecutive ticks Viterbi has decoded as the current regime.
//  Short persistence → regime just started → less reliable.
//  Require min_regime_persistence ticks in NON-REP before trading.
// ══════════════════════════════════════════════════════════════════════════════

class HMMRegimeDetector {
    constructor(config) {
        this.cfg = config;

        // HMM parameters — will be estimated by Baum-Welch
        // State 0 = NON-REP, State 1 = REP
        this.pi = [0.6, 0.4];   // initial distribution
        this.A  = [               // transition matrix
            [0.90, 0.10],         // [P(NR→NR), P(NR→REP)]
            [0.25, 0.75],         // [P(REP→NR), P(REP→REP)]
        ];
        this.B  = [               // emission probs [state][obs]
            [0.92, 0.08],         // NON-REP: P(no-repeat)=0.92, P(repeat)=0.08
            [0.40, 0.60],         // REP:     P(no-repeat)=0.40, P(repeat)=0.60
        ];

        // HSMM sojourn-time parameters (Poisson means per state, in ticks)
        // Learned from Baum-Welch state occupancy; initialised from config priors.
        this.D = [
            config.hsmm_mean_duration_nonrep || 25,  // E[duration | NON-REP]
            config.hsmm_mean_duration_rep    || 15,  // E[duration | REP]
        ];

        // Forward vector [alpha_0, alpha_1] (log-space)
        this.logAlpha = [Math.log(0.6), Math.log(0.4)];
        this.hmmFitted = false;

        // ── BOCPD state ───────────────────────────────────────────────────────
        // Run-length posterior: logRunProbs[r] = log P(r_t = r | x_{1..t})
        // We store up to maxRunLen entries and grow dynamically.
        this.bocpdMaxRun    = 500;       // cap run-length array length
        this.bocpdLogProbs  = [0.0];     // start: P(r_0 = 0) = 1  → log = 0
        // Dirichlet-Multinomial sufficient statistics per run-length
        // alphaCounts[r][d] = alpha0 + count of digit d in current run of length r
        this.bocpdAlpha0    = config.bocpd_alpha0 || 1.0;
        this.bocpdCounts    = [[...new Array(10).fill(this.bocpdAlpha0)]]; // counts for r=0
        this.bocpdHazard    = config.bocpd_hazard || (1 / 50);

        // Per-digit result cache
        this.lastResult = null;
    }

    // ── Baum-Welch (EM) parameter estimation ─────────────────────────────────
    // Runs on the full observation window to learn HMM params from data.
    // Uses log-space arithmetic throughout to prevent underflow.
    baumWelch(obs, maxIter = 20, tol = 1e-5) {
        const T = obs.length;
        if (T < 10) return false;

        const N = 2; // number of states

        let pi = [...this.pi];
        let A  = this.A.map(row => [...row]);
        let B  = this.B.map(row => [...row]);

        let prevLogL = -Infinity;
        // Hoisted so the HSMM duration estimator can read it after the loop ends.
        let lastLogGamma = null;

        for (let iter = 0; iter < maxIter; iter++) {
            // ── Forward pass (log-space) ──────────────────────────────────────
            const logAlpha = Array.from({length: T}, () => new Array(N).fill(-Infinity));

            for (let s = 0; s < N; s++) {
                logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
            }

            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    const incoming = A.map((row, prev) => logAlpha[t-1][prev] + Math.log(row[s] + 1e-300));
                    logAlpha[t][s] = logSumExp(incoming) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }

            const logL = logSumExp(logAlpha[T-1]);

            // ── Backward pass (log-space) ─────────────────────────────────────
            const logBeta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T-1][s] = 0; // log(1) = 0

            for (let t = T-2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    const vals = A[s].map((a, next) =>
                        Math.log(a + 1e-300) + Math.log(B[next][obs[t+1]] + 1e-300) + logBeta[t+1][next]
                    );
                    logBeta[t][s] = logSumExp(vals);
                }
            }

            // ── Compute gamma (state occupancy) and xi (transition) ───────────
            const logGamma = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const denom = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++) {
                    logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - denom;
                }
            }

            const logXi = Array.from({length: T-1}, () =>
                Array.from({length: N}, () => new Array(N).fill(-Infinity))
            );
            for (let t = 0; t < T-1; t++) {
                const denom = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++) {
                    for (let next = 0; next < N; next++) {
                        logXi[t][s][next] =
                            logAlpha[t][s] +
                            Math.log(A[s][next] + 1e-300) +
                            Math.log(B[next][obs[t+1]] + 1e-300) +
                            logBeta[t+1][next] -
                            denom;
                    }
                }
            }

            // ── M-step: re-estimate parameters ───────────────────────────────
            // New pi
            for (let s = 0; s < N; s++) {
                pi[s] = Math.exp(logGamma[0][s]);
            }
            // Normalise pi
            const piSum = pi.reduce((a, b) => a + b, 0);
            pi = pi.map(v => v / piSum);

            // New A
            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0, T-1).map(g => g[s]));
                for (let next = 0; next < N; next++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][next]));
                    A[s][next] = Math.exp(numer - denom);
                }
                // Normalise row
                const rowSum = A[s].reduce((a, b) => a + b, 0);
                A[s] = A[s].map(v => v / rowSum);
            }

            // New B
            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < 2; o++) {
                    const numer = logSumExp(
                        logGamma.filter((_, t) => obs[t] === o).map(g => g[s])
                    );
                    B[s][o] = Math.exp(numer - denom);
                }
                const bSum = B[s].reduce((a, b) => a + b, 0);
                B[s] = B[s].map(v => v / bSum);
            }

            // Convergence check
            lastLogGamma = logGamma; // save for HSMM duration estimation after loop
            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Accept new parameters only if they make sense:
        // State 0 should be the NON-REP state (lower repeat emission)
        // If Baum-Welch swapped them, un-swap.
        if (B[0][1] > B[1][1]) {
            // Swap states
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        this.pi = pi;
        this.A  = A;
        this.B  = B;
        this.hmmFitted = true;

        // ── HSMM: estimate sojourn-time Poisson means from gamma ─────────────
        const stateTotals = [0, 0];
        const runSums = [0, 0];
        if (lastLogGamma) {
            let curRunState = Math.exp(lastLogGamma[0][0]) > 0.5 ? 0 : 1;
            let curRunLen = 1;
            for (let t = 1; t < T; t++) {
                const s = Math.exp(lastLogGamma[t][0]) > 0.5 ? 0 : 1;
                if (s === curRunState) {
                    curRunLen++;
                } else {
                    stateTotals[curRunState]++;
                    runSums[curRunState] += curRunLen;
                    curRunState = s;
                    curRunLen = 1;
                }
            }
            stateTotals[curRunState]++;
            runSums[curRunState] += curRunLen;
        }
        for (let s = 0; s < 2; s++) {
            if (stateTotals[s] > 0) {
                const estDuration = runSums[s] / stateTotals[s];
                this.D[s] = clamp(0.7 * estDuration + 0.3 * this.D[s], 5, 100);
            }
        }

        return true;
    }

    // ── HSMM Duration-Penalised Viterbi ──────────────────────────────────────
    // Extends standard Viterbi with a Poisson sojourn-time log-penalty.
    // At each time step, if the decoder stays in the same state, we add
    // log P(run_len | Poisson(D[state])) to the path score.
    // This naturally penalises staying in a state well beyond its learned
    // expected lifetime, forcing the decoder to predict regime transitions.
    //
    // logPoissonPMF(k, lambda) = k*log(lambda) - lambda - log(k!)
    poissonLogPMF(k, lambda) {
        if (k < 0 || lambda <= 0) return -Infinity;
        let logFact = 0;
        for (let i = 2; i <= k; i++) logFact += Math.log(i);
        return k * Math.log(lambda) - lambda - logFact;
    }

    viterbi(obs) {
        const T = obs.length;
        const N = 2;
        if (T === 0) return null;

        const logDelta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
        const psi      = Array.from({length: T}, () => new Array(N).fill(0));

        // Track current run length per state for duration penalty
        const runLen = new Array(N).fill(1);

        for (let s = 0; s < N; s++) {
            logDelta[0][s] = Math.log(this.pi[s] + 1e-300) + Math.log(this.B[s][obs[0]] + 1e-300);
        }

        for (let t = 1; t < T; t++) {
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bestPrev = 0;
                for (let prev = 0; prev < N; prev++) {
                    let v = logDelta[t-1][prev] + Math.log(this.A[prev][s] + 1e-300);
                    // HSMM duration penalty: if staying in same state, add
                    // log P(current run length | Poisson(D[s]))
                    if (prev === s) {
                        // run length is implicitly tracked via the path;
                        // use a scaled penalty based on how far past the
                        // expected duration we are (soft penalty)
                        const expectedDur = this.D[s];
                        // Count consecutive same-state steps ending at t-1
                        // Approximate: use a scaled log-likelihood penalty
                        const approxRunLen = Math.min(runLen[s], 60);
                        const durLogPenalty = this.poissonLogPMF(approxRunLen, expectedDur);
                        // Scale penalty gently (don't overwhelm emission signal)
                        v += 0.15 * durLogPenalty;
                    }
                    if (v > best) { best = v; bestPrev = prev; }
                }
                logDelta[t][s] = best + Math.log(this.B[s][obs[t]] + 1e-300);
                psi[t][s] = bestPrev;
            }
        }

        // Backtrace
        const stateSeq = new Array(T);
        stateSeq[T-1] = logDelta[T-1][0] >= logDelta[T-1][1] ? 0 : 1;
        for (let t = T-2; t >= 0; t--) {
            stateSeq[t] = psi[t+1][stateSeq[t+1]];
        }

        // Compute regime persistence (consecutive ticks in current state at tail)
        const curState = stateSeq[T-1];
        let persistence = 1;
        for (let t = T-2; t >= 0; t--) {
            if (stateSeq[t] === curState) persistence++;
            else break;
        }

        // Count regime transitions in the window
        let transitions = 0;
        for (let t = 1; t < T; t++) {
            if (stateSeq[t] !== stateSeq[t-1]) transitions++;
        }

        return { stateSeq, currentState: curState, persistence, transitions };
    }

    // ── Forward algorithm (incremental — O(N^2) per tick) ─────────────────────
    // Updates Bayesian posterior P(state | obs_1..t) in log-space.
    updateForward(obs_t) {
        const N = 2;
        const logAlphaNew = new Array(N);
        for (let s = 0; s < N; s++) {
            const incoming = this.logAlpha.map((la, prev) =>
                la + Math.log(this.A[prev][s] + 1e-300)
            );
            logAlphaNew[s] = logSumExp(incoming) + Math.log(this.B[s][obs_t] + 1e-300);
        }
        const denom = logSumExp(logAlphaNew);
        this.logAlpha = logAlphaNew;

        // Posterior: P(S0 | history) and P(S1 | history)
        return [
            Math.exp(logAlphaNew[0] - denom),  // P(NON-REP)
            Math.exp(logAlphaNew[1] - denom),   // P(REP)
        ];
    }

    // ── BOCPD: Bayesian Online Change-Point Detection ─────────────────────────
    // Dirichlet-Multinomial conjugate model for categorical digit observations.
    //
    // At each tick with observed digit x ∈ {0..9}:
    //   1. Compute predictive probability p(x | run r) for each run length r.
    //   2. Update run-length posteriors: grow each existing run by 1,
    //      add a new run (r=0) with probability = hazard rate h.
    //   3. Normalise.
    //
    // The alarm fires when P(r_t > min_run_length) < run_confidence.
    // This means the regime is TOO YOUNG — we cannot trust it yet.
    // Trade is only allowed when the current regime is OLD ENOUGH (stable).
    //
    // Returns { alarm: bool, runLengthProb: float, maxRunLengthProb: float }
    updateBOCPD(digit) {
        const h      = this.bocpdHazard;
        const alpha0 = this.bocpdAlpha0;
        const K      = 10; // number of digit categories

        const nRuns = this.bocpdLogProbs.length;

        // Step 1: compute log predictive for each run length
        // P(x_t | r_{t-1}=r, alpha) = (alpha_r[x] ) / sum(alpha_r)
        // where alpha_r[x] = alpha0 + count[r][x]
        const logPredictive = new Array(nRuns);
        for (let r = 0; r < nRuns; r++) {
            const counts = this.bocpdCounts[r];
            const sumAlpha = counts.reduce((a, b) => a + b, 0);
            logPredictive[r] = Math.log(counts[digit] + 1e-300) - Math.log(sumAlpha + 1e-300);
        }

        // Step 2: compute new log run-length probabilities
        // Growth:   P(r_t = r+1 | x_t) ∝ P(x_t | r) * P(r_{t-1}=r) * (1-h)
        // Change:   P(r_t = 0  | x_t) ∝ Σ_r P(x_t | r) * P(r_{t-1}=r) * h
        const logOneMinusH = Math.log(1 - h + 1e-300);
        const logH         = Math.log(h + 1e-300);

        // Change-point probability: sum over all runs of logP(x|r) + logP(r) + logH
        const logCPTerms = this.bocpdLogProbs.map((lp, r) => lp + logPredictive[r] + logH);
        const logCP = logSumExp(logCPTerms);

        // Growth terms
        const newLogProbs = new Array(nRuns + 1);
        newLogProbs[0] = logCP; // new run starting here
        for (let r = 0; r < nRuns; r++) {
            newLogProbs[r + 1] = this.bocpdLogProbs[r] + logPredictive[r] + logOneMinusH;
        }

        // Normalise
        const logNorm = logSumExp(newLogProbs);
        const normProbs = newLogProbs.map(lp => lp - logNorm);

        // Update counts: grow each run's counts with the new digit observation
        const newCounts = new Array(nRuns + 1);
        // New run (r=0): start fresh with alpha0 priors + this digit
        newCounts[0] = new Array(K).fill(alpha0);
        newCounts[0][digit]++;
        // Grow existing runs
        for (let r = 0; r < nRuns; r++) {
            newCounts[r + 1] = [...this.bocpdCounts[r]];
            newCounts[r + 1][digit]++;
        }

        // Trim to max run length to bound memory
        const maxRun = this.bocpdMaxRun;
        if (normProbs.length > maxRun) {
            const trimmed = normProbs.slice(0, maxRun);
            const logTrimNorm = logSumExp(trimmed);
            this.bocpdLogProbs = trimmed.map(lp => lp - logTrimNorm);
            this.bocpdCounts   = newCounts.slice(0, maxRun);
        } else {
            this.bocpdLogProbs = normProbs;
            this.bocpdCounts   = newCounts;
        }

        // Compute P(r_t > min_run_length) — probability regime is old enough
        const minRun = this.cfg.bocpd_min_run_length || 15;
        const confThreshold = this.cfg.bocpd_run_confidence || 0.95;

        let probOldEnough = 0;
        for (let r = minRun + 1; r < this.bocpdLogProbs.length; r++) {
            probOldEnough += Math.exp(this.bocpdLogProbs[r]);
        }

        // Alarm: regime is TOO NEW (run too short to trust)
        const alarm = probOldEnough < confThreshold;

        // Most probable run length (for diagnostics)
        let maxRunIdx = 0, maxRunLogProb = -Infinity;
        for (let r = 0; r < this.bocpdLogProbs.length; r++) {
            if (this.bocpdLogProbs[r] > maxRunLogProb) {
                maxRunLogProb = this.bocpdLogProbs[r];
                maxRunIdx = r;
            }
        }

        return {
            alarm,
            probOldEnough,      // P(run_length > min_run_length) — want this ≥ 0.95
            mostLikelyRun: maxRunIdx,
            runCount: this.bocpdLogProbs.length,
        };
    }

    resetBOCPD() {
        this.bocpdLogProbs = [0.0];
        this.bocpdCounts   = [[...new Array(10).fill(this.bocpdAlpha0)]];
    }

    // ── Shannon Entropy Filter ────────────────────────────────────────────────
    // Computes rolling Shannon entropy H(X) over the last N raw digit ticks.
    // H(X) = -Σ p(x) log2 p(x)   for x ∈ {0..9}
    // Maximum entropy = log2(10) ≈ 3.321 bits (perfectly uniform).
    //
    // High H (> 3.1) → digits are well-distributed → genuinely random market.
    // Low H  (< 2.8) → digits are clumping → market is predictable → DANGER.
    computeShannonEntropy(digitWindow) {
        const counts = new Array(10).fill(0);
        const n = digitWindow.length;
        if (n === 0) return 0;
        for (const d of digitWindow) counts[d]++;
        let H = 0;
        for (let d = 0; d < 10; d++) {
            if (counts[d] > 0) {
                const p = counts[d] / n;
                H -= p * Math.log2(p);
            }
        }
        return H;
    }

    // ── Per-digit raw repeat probability (from transition counts) ─────────────
    computePerDigitStats(window) {
        const len = window.length;
        const repeatCount   = new Array(10).fill(0);
        const totalCount    = new Array(10).fill(0);
        const ewmaRepeat    = new Array(10).fill(null);
        const ALPHA = 0.15;

        for (let i = 0; i < len; i++) {
            const d = window[i];
            totalCount[d]++;
            const isRepeat = i > 0 && window[i] === window[i-1];
            if (i > 0) repeatCount[window[i-1]]++;  // count transitions FROM window[i-1]

            // EWMA on per-digit repeat event
            if (ewmaRepeat[d] === null) {
                ewmaRepeat[d] = isRepeat ? 100 : 0;
            } else {
                ewmaRepeat[d] = ALPHA * (isRepeat ? 100 : 0) + (1 - ALPHA) * ewmaRepeat[d];
            }
        }

        // Compute transition-based repeat prob per digit
        const rawRepeatProb = new Array(10).fill(0);
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);

        for (let i = 0; i < len - 1; i++) {
            const d = window[i];
            transFrom[d]++;
            if (window[i+1] === d) transRepeat[d]++;
        }

        for (let d = 0; d < 10; d++) {
            rawRepeatProb[d] = transFrom[d] > 0 ? (transRepeat[d] / transFrom[d]) * 100 : 10;
            if (ewmaRepeat[d] === null) ewmaRepeat[d] = 10;
        }

        return { rawRepeatProb, ewmaRepeat };
    }

    // ── Full regime analysis ───────────────────────────────────────────────────
    // Returns a rich regime object for a specific target digit.
    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;

        if (len < this.cfg.min_ticks_for_hmm) {
            return { valid: false, reason: 'insufficient data' };
        }

        // ── Build binary observation sequence (global, not per-digit) ──────────
        // obs[t] = 1 if tick[t] repeated tick[t-1], else 0
        const obs = new Array(len - 1);
        for (let t = 1; t < len; t++) {
            obs[t-1] = window[t] === window[t-1] ? 1 : 0;
        }

        // ── Baum-Welch: re-fit HMM parameters on this window ──────────────────
        // Only re-fit every 50 ticks (expensive) — use flag
        if (!this.hmmFitted || tickHistory.length % 50 === 0) {
            const fitted = this.baumWelch(obs);
            if (fitted) {
                logHMM(
                    `📐 HMM params updated | ` +
                    `A: NR→NR=${(this.A[0][0]*100).toFixed(1)}% NR→R=${(this.A[0][1]*100).toFixed(1)}% ` +
                    `R→NR=${(this.A[1][0]*100).toFixed(1)}% R→R=${(this.A[1][1]*100).toFixed(1)}% | ` +
                    `B(repeat|NR)=${(this.B[0][1]*100).toFixed(1)}% B(repeat|R)=${(this.B[1][1]*100).toFixed(1)}%`
                );
            }
        }

        // ── Viterbi decoding ───────────────────────────────────────────────────
        const vit = this.viterbi(obs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        // ── Forward (Bayesian) posterior ────────────────────────────────────────
        // Re-run forward from scratch for accurate posterior
        let logA = [Math.log(this.pi[0] + 1e-300), Math.log(this.pi[1] + 1e-300)];
        logA[0] += Math.log(this.B[0][obs[0]] + 1e-300);
        logA[1] += Math.log(this.B[1][obs[0]] + 1e-300);
        for (let t = 1; t < obs.length; t++) {
            const newA = new Array(2);
            for (let s = 0; s < 2; s++) {
                const vals = [
                    logA[0] + Math.log(this.A[0][s] + 1e-300),
                    logA[1] + Math.log(this.A[1][s] + 1e-300),
                ];
                newA[s] = logSumExp(vals) + Math.log(this.B[s][obs[t]] + 1e-300);
            }
            logA = newA;
        }
        const denom = logSumExp(logA);
        const posteriorNonRep = Math.exp(logA[0] - denom);
        const posteriorRep    = Math.exp(logA[1] - denom);

        // ── BOCPD: update with each recent raw digit tick ──────────────────────
        // Feed the last `recentLen` raw digits into BOCPD one by one.
        // BOCPD operates on the raw digit stream (not binary obs), giving it
        // a richer signal via the Dirichlet-Multinomial conjugate model.
        const recentLen = Math.min(len, 30);
        const recentWindow = window.slice(-recentLen);
        for (const d of recentWindow) {
            this.updateBOCPD(d);
        }
        const bocpdResult = this.updateBOCPD(window[window.length - 1]); // final update
        const bocpdAlarm = bocpdResult.alarm;

        // ── Shannon Entropy: model-free randomness gate ────────────────────────
        // Computed on last entropy_window raw digit ticks (default 30).
        const entropyWin = this.cfg.entropy_window || 30;
        const entropyWindow = window.slice(-entropyWin);
        const shannonH = this.computeShannonEntropy(entropyWindow);
        const H_HIGH = this.cfg.entropy_high || 3.1;
        const H_LOW  = this.cfg.entropy_low  || 2.8;

        // ── Per-digit statistics ───────────────────────────────────────────────
        const { rawRepeatProb, ewmaRepeat } = this.computePerDigitStats(window);

        // ── Recent repeat rate in last 20 ticks (short window for reactivity) ──
        const shortWindow = window.slice(-20);
        let recentRepeatCount = 0, recentTotal = 0;
        for (let i = 1; i < shortWindow.length; i++) {
            if (shortWindow[i-1] === targetDigit || shortWindow[i] === targetDigit) {
                recentTotal++;
                if (shortWindow[i] === shortWindow[i-1]) recentRepeatCount++;
            }
        }
        const recentRepeatRate = recentTotal > 0 ? (recentRepeatCount / recentTotal) * 100 : rawRepeatProb[targetDigit];

        // ── Regime stability: variance of state over rolling windows ──────────
        // Segment the decoded state sequence into 5 equal parts.
        // If all parts agree on NON-REP → stable.
        const seqLen = vit.stateSeq.length;
        const segSize = Math.floor(seqLen / 5);
        const segmentStates = [];
        for (let seg = 0; seg < 5 && seg * segSize < seqLen; seg++) {
            const segSlice = vit.stateSeq.slice(seg * segSize, (seg + 1) * segSize);
            const nonRepFrac = segSlice.filter(s => s === 0).length / segSlice.length;
            segmentStates.push(nonRepFrac);
        }
        const regimeStability = segmentStates.reduce((a, b) => a + b, 0) / segmentStates.length;

        // ── Compute composite safety score (0-100) ────────────────────────────
        let safetyScore = 0;
        const threshold = this.cfg.repeat_threshold;

        // Component A: HSMM Viterbi state (35 pts)
        if (vit.currentState === 0) safetyScore += 35;

        // Component B: Bayesian posterior confidence (25 pts)
        safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 25);

        // Component C: Regime persistence (15 pts)
        const persistenceScore = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
        safetyScore += Math.round(persistenceScore * 15);

        // Component D: Regime stability across segments (10 pts)
        safetyScore += Math.round(regimeStability * 10);

        // Component E: Shannon entropy boost/penalty (15 pts)
        // H > H_HIGH → random market → full 15 pts
        // H_LOW < H ≤ H_HIGH → scaled partial pts
        // H ≤ H_LOW → zero out safetyScore immediately (hard gate)
        if (shannonH > H_HIGH) {
            safetyScore += 15;
        } else if (shannonH > H_LOW) {
            safetyScore += Math.round(((shannonH - H_LOW) / (H_HIGH - H_LOW)) * 15);
        }
        // (if H ≤ H_LOW, no entropy points added — hard gate below zeros it out)

        // Hard gates: zero out if conditions fail
        if (vit.currentState !== 0) safetyScore = 0;              // Must be in NON-REP
        if (posteriorNonRep < this.cfg.hmm_nonrep_confidence) safetyScore = Math.min(safetyScore, 35);
        if (rawRepeatProb[targetDigit] >= threshold) safetyScore = 0;     // raw rate gate
        if (bocpdAlarm) safetyScore = 0;                           // BOCPD alarm gate
        if (shannonH <= H_LOW) safetyScore = 0;                   // Entropy gate (hard)

        // ── Signal condition ───────────────────────────────────────────────────
        const signalActive = (
            vit.currentState === 0 &&
            posteriorNonRep >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            rawRepeatProb[targetDigit] < threshold &&
            ewmaRepeat[targetDigit] < threshold &&
            !bocpdAlarm &&
            shannonH > H_LOW &&
            safetyScore >= this.cfg.repeat_confidence
        );

        return {
            valid: true,
            // HSMM
            hmmState: vit.currentState,          // 0=NON-REP, 1=REP
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            regimeStability,
            hsmmDurations: [...this.D],          // [D_nonrep, D_rep] learned sojourn means
            // Bayesian
            posteriorNonRep,
            posteriorRep,
            // BOCPD
            bocpdAlarm,
            bocpdRunProb: bocpdResult.probOldEnough,   // P(run > min_run_length)
            bocpdMostLikelyRun: bocpdResult.mostLikelyRun,
            // Shannon Entropy
            shannonEntropy: shannonH,
            entropyHealthy: shannonH > H_LOW,
            entropyRandom: shannonH > H_HIGH,
            // Per-digit rates
            rawRepeatProb,
            ewmaRepeat,
            recentRepeatRate,
            // Model params (for logging)
            hmmA: this.A,
            hmmB: this.B,
            // Composite
            safetyScore,
            signalActive,
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class RomanianGhostBot {
    constructor(config) {
        this.config = config;

        this.ws = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT = 5;
        this.pingInterval = null;
        this.requestId = 0;

        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';

        this.tickHistory = [];

        // HMM Regime Detector
        this.hmm = new HMMRegimeDetector(config);

        this.regime = null;
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;

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

        // Session stats
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

        this.cooldownTimer = null;
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    }

    start() {
        this.printBanner();
        this.connectWS();
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v3.0  —  Deriv Digit Differ          ')));
        console.log(bold(cyan('   HSMM + BOCPD + Shannon Entropy Regime Engine                ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log(`  Symbol            : ${bold(c.symbol)}`);
        console.log(`  Base Stake        : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window   : ${bold(c.analysis_window)} ticks`);
        console.log(`  HMM Min Ticks     : ${bold(c.min_ticks_for_hmm)}`);
        console.log(`  Repeat Threshold  : ${bold(c.repeat_threshold + '%')}`);
        console.log(`  HMM NonRep Conf   : ${bold((c.hmm_nonrep_confidence * 100).toFixed(0) + '%')} posterior required`);
        console.log(`  Min Persistence   : ${bold(c.min_regime_persistence)} ticks in NON-REP regime`);
        console.log(`  BOCPD Hazard      : ${bold((c.bocpd_hazard * 100).toFixed(2) + '% /tick')} (regime ~${bold(Math.round(1/c.bocpd_hazard))}t)`);
        console.log(`  BOCPD Min Run     : ${bold(c.bocpd_min_run_length)} ticks stable @ ${bold((c.bocpd_run_confidence * 100).toFixed(0) + '% conf')}`);
        console.log(`  Entropy Window    : ${bold(c.entropy_window)} ticks | Low: ${red(c.entropy_low)} | High: ${green(c.entropy_high)} bits`);
        console.log(`  HSMM Durations    : NR ~${bold(c.hsmm_mean_duration_nonrep)}t  REP ~${bold(c.hsmm_mean_duration_rep)}t (learned)`);
        console.log(`  Ghost Trading     : ${c.ghost_enabled ? green('ON') + ` | Wins Required: ${bold(c.ghost_wins_required)}` : red('OFF')}`);
        console.log(`  Martingale        : ${c.martingale_enabled ? green('ON') + ` | Max Steps: ${c.max_martingale_steps} | Mult: ${c.martingale_multiplier}x` : red('OFF')}`);
        console.log(`  Take Profit       : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss         : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log('');
        console.log(bold(yellow('  REGIME DETECTION ENGINE v3.0:')));
        console.log(dim('  1. Baum-Welch HSMM — learns emission probs + sojourn-time Poisson means'));
        console.log(dim('  2. Duration-Penalised Viterbi — predicts imminent regime flips'));
        console.log(dim('  3. Forward algorithm → Bayesian P(NON-REP | all history)'));
        console.log(dim('  4. BOCPD (Dirichlet-Multinomial) — exact posterior run-length distribution'));
        console.log(dim('  5. Shannon Entropy H(X) — model-free clumping/randomness gate'));
        console.log(dim('  6. Regime persistence + multi-segment stability check'));
        console.log('');
    }

    // ── WebSocket ────────────────────────────────────────────────────────────────
    connectWS() {
        this.botState = STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);
        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            logError(`Failed to create WebSocket: ${e.message}`);
            this.attemptReconnect();
            return;
        }
        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = STATE.AUTHENTICATING;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
            }, 30_000);
            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });
        this.ws.on('message', raw => {
            try { this.handleMessage(JSON.parse(raw)); }
            catch (e) { logError(`Parse error: ${e.message}`); }
        });
        this.ws.on('close', code => {
            logApi(`⚠️  Connection closed (code: ${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });
        this.ws.on('error', e => logError(`WebSocket error: ${e.message}`));
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) {
            logError(`Max reconnection attempts reached. Stopping.`);
            this.stop('Max reconnect attempts exceeded');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
        logApi(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
        this.isTradeActive = false;
        setTimeout(() => { if (this.botState !== STATE.STOPPED) this.connectWS(); }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); }
        catch (e) { logError(`Send error: ${e.message}`); }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => {});
    }

    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize':    this.handleAuth(msg); break;
            case 'balance':      this.handleBalance(msg); break;
            case 'history':      this.handleTickHistory(msg); break;
            case 'tick':         this.handleTick(msg); break;
            case 'buy':          this.handleBuy(msg); break;
            case 'transaction':  this.handleTransaction(msg); break;
            case 'ping': break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown error';
        logError(`[${code}] on ${msg.msg_type || 'unknown'}: ${emsg}`);
        switch (code) {
            case 'InvalidToken':
            case 'AuthorizationRequired':
                this.stop('Authentication failed');
                break;
            case 'RateLimit':
                setTimeout(() => {
                    if (this.botState !== STATE.STOPPED) {
                        this.isTradeActive = false;
                        this.executeTradeFlow(false);
                    }
                }, 10_000);
                break;
            case 'InsufficientBalance':
                this.stop('Insufficient balance');
                break;
            default:
                if (msg.msg_type === 'buy') {
                    this.isTradeActive = false;
                    this.botState = STATE.ANALYZING;
                }
        }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        this.sessionStartTime = Date.now();
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(
            `${green('✅ Authenticated')} | Account: ${bold(this.accountId)} ` +
            `${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | ` +
            `Balance: ${green('$' + this.accountBalance.toFixed(2))}`
        );
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT — trading with real money!');
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.botState = STATE.COLLECTING_TICKS;
        logBot(`Fetching last ${bold(this.config.tick_history_size)} ticks for ${bold(this.config.symbol)}...`);
        this.send({
            ticks_history: this.config.symbol,
            count: this.config.tick_history_size,
            end: 'latest',
            style: 'ticks',
        });
    }

    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) {
            logError('Failed to fetch tick history.');
            this.subscribeToLiveTicks();
            return;
        }
        const prices = msg.history.prices;
        const digits = prices.map(p => getLastDigit(p, this.config.symbol));
        this.tickHistory = digits.slice(-this.config.tick_history_size);
        logBot(`${green('✅ Loaded ' + this.tickHistory.length + ' historical ticks')}`);
        logTick(`History tail (last 10): [${this.tickHistory.slice(-10).join(', ')}]`);
        this.subscribeToLiveTicks();
        if (this.tickHistory.length >= this.config.min_ticks_for_hmm) {
            this.botState = STATE.ANALYZING;
            const lastDigit = this.tickHistory[this.tickHistory.length - 1];
            this.regime = this.hmm.analyze(this.tickHistory, lastDigit);
            this.applyRegimeSignal(lastDigit);
            this.logRegimeAnalysis(lastDigit);
        } else {
            logBot(`Collecting more ticks (${this.tickHistory.length}/${this.config.min_ticks_for_hmm})...`);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to live ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    // ── Live Tick Handler ─────────────────────────────────────────────────────
    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;

        const price = msg.tick.quote;
        const currentDigit = getLastDigit(price, this.config.symbol);

        this.tickHistory.push(currentDigit);
        if (this.tickHistory.length > this.config.tick_history_size)
            this.tickHistory = this.tickHistory.slice(-this.config.tick_history_size);

        const count = this.tickHistory.length;
        const histLen = this.tickHistory.length;
        const last5 = histLen >= 2 ? this.tickHistory.slice(Math.max(0, histLen - 6), histLen - 1) : [];
        const last5Str = last5.length > 0 ? last5.join(' › ') : '—';
        const stateHint =
            this.botState === STATE.WAITING_RESULT ? '⏳ waiting result'
            : this.botState === STATE.COOLDOWN ? '❄️ cooldown'
            : this.botState === STATE.GHOST_TRADING
                ? `👻 ghost ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
            : '';
        logTick(
            dim(`${last5Str} ›`) + ` ${bold(cyan(`[${currentDigit}]`))}` +
            dim(`  ${price}  (${count}/${this.config.tick_history_size})`) +
            (stateHint ? `  ${dim(stateHint)}` : '')
        );

        // Pending trade gate
        if (this.pendingTrade && !this.isTradeActive && this.botState !== STATE.STOPPED) {
            if (currentDigit === this.targetDigit) {
                this.pendingTrade = false;
                this.placeTrade();
                return;
            }
            logGhost(dim(`⏳ Waiting for digit ${bold(this.targetDigit)} — current: ${currentDigit}`));
            return;
        }

        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (count >= this.config.min_ticks_for_hmm) {
                    this.botState = STATE.ANALYZING;
                    this.regime = this.hmm.analyze(this.tickHistory, currentDigit);
                    this.applyRegimeSignal(currentDigit);
                    this.logRegimeAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;

            case STATE.ANALYZING:
                this.regime = this.hmm.analyze(this.tickHistory, currentDigit);
                this.applyRegimeSignal(currentDigit);
                this.logRegimeAnalysis(currentDigit);
                if (this.signalActive) this.processSignal(currentDigit);
                break;

            case STATE.GHOST_TRADING:
                this.regime = this.hmm.analyze(this.tickHistory, this.targetDigit);
                this.refreshSignalForLockedTarget();
                this.runGhostCheck(currentDigit);
                break;

            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                this.regime = this.hmm.analyze(this.tickHistory, currentDigit);
                break;
        }
    }

    // ── Signal application ─────────────────────────────────────────────────────
    applyRegimeSignal(currentDigit) {
        this.targetDigit = currentDigit;
        if (!this.regime || !this.regime.valid) { this.signalActive = false; return; }
        this.targetRepeatRate = this.regime.rawRepeatProb[currentDigit];
        this.signalActive = this.regime.signalActive;
    }

    refreshSignalForLockedTarget() {
        if (this.targetDigit < 0 || !this.regime || !this.regime.valid) return;
        this.targetRepeatRate = this.regime.rawRepeatProb[this.targetDigit];
        this.signalActive = this.regime.signalActive;
    }

    // ── Regime logging ─────────────────────────────────────────────────────────
    logRegimeAnalysis(currentDigit) {
        if (!this.regime || !this.regime.valid) return;
        const r = this.regime;
        const threshold = this.config.repeat_threshold;

        // Rate display
        const rateStr = r.rawRepeatProb.map((rp, i) => {
            const isTarget = i === currentDigit;
            if (isTarget) {
                const ok = rp < threshold && r.ewmaRepeat[i] < threshold;
                return (ok ? green : red)(`${i}:${rp.toFixed(0)}%/🄴${r.ewmaRepeat[i].toFixed(0)}%`);
            }
            return dim(`${i}:${rp.toFixed(0)}%`);
        }).join(' ');

        logAnalysis(`Rates [raw/EWMA]: [${rateStr}]`);

        // HMM state
        const stateCol = r.hmmState === 0 ? green : yellow;
        const posteriorPct = (r.posteriorNonRep * 100).toFixed(1);
        const stabPct = (r.regimeStability * 100).toFixed(1);

        logHMM(
            `State: ${stateCol(bold(r.hmmStateName))} | ` +
            `P(NON-REP): ${r.posteriorNonRep >= this.config.hmm_nonrep_confidence ? green(posteriorPct + '%') : red(posteriorPct + '%')} | ` +
            `Persist: ${r.hmmPersistence >= this.config.min_regime_persistence ? green(r.hmmPersistence + ' ticks') : yellow(r.hmmPersistence + ' ticks')} | ` +
            `Stability: ${parseFloat(stabPct) >= 70 ? green(stabPct + '%') : yellow(stabPct + '%')} | ` +
            `Transitions: ${dim(r.hmmTransitions)} | ` +
            `HSMM D: NR=${r.hsmmDurations[0].toFixed(1)}t R=${r.hsmmDurations[1].toFixed(1)}t`
        );

        logHMM(
            `HMM: B(rep|NR)=${(r.hmmB[0][1]*100).toFixed(1)}% B(rep|R)=${(r.hmmB[1][1]*100).toFixed(1)}% | ` +
            `A(NR→R)=${(r.hmmA[0][1]*100).toFixed(1)}% A(R→NR)=${(r.hmmA[1][0]*100).toFixed(1)}% | ` +
            `Safety: ${r.safetyScore >= 85 ? green(r.safetyScore+'/100') : red(r.safetyScore+'/100')} | ` +
            `Recent(20t): ${r.recentRepeatRate.toFixed(1)}%`
        );

        const entropyCol = r.shannonEntropy > (this.config.entropy_high || 3.1) ? green
                         : r.shannonEntropy > (this.config.entropy_low  || 2.8) ? yellow : red;
        const bocpdCol = r.bocpdAlarm ? red : green;
        logHMM(
            `BOCPD: ${bocpdCol(r.bocpdAlarm ? `⚠️ ALARM` : `✅ OK`)} ` +
            `P(run>${this.config.bocpd_min_run_length||15})=${(r.bocpdRunProb*100).toFixed(1)}% ` +
            `MostLikelyRun=${r.bocpdMostLikelyRun}t | ` +
            `Entropy H=${entropyCol(r.shannonEntropy.toFixed(3))}bits ` +
            `(${r.entropyRandom ? green('RANDOM') : r.entropyHealthy ? yellow('OK') : red('CLUMPING')})`
        );

        if (this.signalActive) {
            logAnalysis(green(
                `✅ SIGNAL ACTIVE — digit ${currentDigit} | ` +
                `HMM:${r.hmmStateName} P(NR):${posteriorPct}% ` +
                `persist:${r.hmmPersistence} score:${r.safetyScore}/100 → DIFFER`
            ));
        } else {
            const reasons = [];
            if (!r.valid) reasons.push('HMM not ready');
            else {
                if (r.hmmState !== 0) reasons.push(`HMM state=${r.hmmStateName}`);
                if (r.posteriorNonRep < this.config.hmm_nonrep_confidence) reasons.push(`P(NR)=${posteriorPct}%<${(this.config.hmm_nonrep_confidence*100).toFixed(0)}%`);
                if (r.hmmPersistence < this.config.min_regime_persistence) reasons.push(`persist=${r.hmmPersistence}<${this.config.min_regime_persistence}`);
                if (r.rawRepeatProb[currentDigit] >= threshold) reasons.push(`raw=${r.rawRepeatProb[currentDigit].toFixed(1)}%≥${threshold}%`);
                if (r.ewmaRepeat[currentDigit] >= threshold) reasons.push(`EWMA=${r.ewmaRepeat[currentDigit].toFixed(1)}%≥${threshold}%`);
                if (r.bocpdAlarm) reasons.push(`BOCPD ALARM P(run>${this.config.bocpd_min_run_length||15})=${(r.bocpdRunProb*100).toFixed(1)}%`);
                if (!r.entropyHealthy) reasons.push(`H=${r.shannonEntropy.toFixed(3)}<${this.config.entropy_low||2.8} (clumping)`);
                if (r.safetyScore < 85) reasons.push(`score=${r.safetyScore}<85`);
            }
            logAnalysis(red(`⛔ NO SIGNAL — digit ${currentDigit}: ${reasons.join(', ')} → WAIT`));
        }
    }

    // ── Signal → Ghost / Trade ────────────────────────────────────────────────
    processSignal(currentDigit) {
        if (!this.signalActive) { this.botState = STATE.ANALYZING; return; }

        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            const r = this.regime;
            logGhost(
                `👻 Ghost phase started. Target: ${bold(cyan(this.targetDigit))} | ` +
                `P(NR):${(r.posteriorNonRep * 100).toFixed(1)}% score:${r.safetyScore}/100 | ` +
                `Need ${bold(this.config.ghost_wins_required)} non-repeat(s).`
            );
            this.runGhostCheck(currentDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    // ── Ghost Trading (Two-Tick Model) ────────────────────────────────────────
    runGhostCheck(currentDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;

        if (!this.signalActive) {
            logGhost(dim(`⏳ Signal lost for digit ${this.targetDigit} — re-analyzing...`));
            this.resetGhost();
            this.botState = STATE.ANALYZING;
            return;
        }

        this.ghostRoundsPlayed++;

        if (this.ghostAwaitingResult) {
            this.ghostAwaitingResult = false;
            if (currentDigit !== this.targetDigit) {
                this.ghostConsecutiveWins++;
                logGhost(`👻 ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} — digit ${bold(cyan(this.targetDigit))} did NOT repeat (next: ${bold(currentDigit)})`);
            } else {
                const had = this.ghostConsecutiveWins;
                this.ghostConsecutiveWins = 0;
                logGhost(`👻 ${red(`❌ Ghost LOSS — digit REPEATED`)} (had ${had} wins) — reset 0/${this.config.ghost_wins_required}`);
            }
        } else {
            if (currentDigit === this.targetDigit) {
                const winsIfConfirmed = this.ghostConsecutiveWins + 1;
                if (winsIfConfirmed >= this.config.ghost_wins_required) {
                    this.ghostConsecutiveWins = winsIfConfirmed;
                    this.ghostConfirmed = true;
                    logGhost(`👻 Target digit ${bold(cyan(this.targetDigit))} appeared! ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
                    logGhost(green(bold(`✅ Ghost confirmed! Executing LIVE trade on digit ${this.targetDigit} NOW!`)));
                    this.executeTradeFlow(true);
                } else {
                    this.ghostAwaitingResult = true;
                    logGhost(`👻 Target digit ${bold(cyan(this.targetDigit))} appeared | Wins: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required} | ${dim('Awaiting next tick...')}`);
                }
            } else {
                logGhost(dim(`⏳ Digit ${currentDigit} — waiting for ${bold(this.targetDigit)} (${this.ghostConsecutiveWins}/${this.config.ghost_wins_required})`));
                this.refreshSignalForLockedTarget();
                if (!this.signalActive) {
                    logGhost(dim(`Signal lost — returning to ANALYZING`));
                    this.resetGhost();
                    this.botState = STATE.ANALYZING;
                    return;
                }
            }
        }

        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`⚠️  Max ghost rounds reached. Re-analyzing...`));
            this.resetGhost();
            this.botState = STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;
        this.targetDigit = -1;
        this.signalActive = false;
    }

    // ── Trade Execution ───────────────────────────────────────────────────────
    executeTradeFlow(immediate) {
        if (this.isTradeActive || this.pendingTrade || this.botState === STATE.STOPPED) return;
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
            return;
        }
        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake) {
            logRisk(`Stake $${this.currentStake.toFixed(2)} exceeds max`);
            this.stop('Stake exceeds maximum');
            return;
        }
        if (this.currentStake > this.accountBalance) {
            this.stop('Insufficient balance for stake');
            return;
        }
        if (immediate) {
            this.placeTrade();
        } else {
            this.pendingTrade = true;
            this.botState = STATE.GHOST_TRADING;
            logBot(`⚡ Recovery trade queued — waiting for digit ${bold(cyan(this.targetDigit))}`);
        }
    }

    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;
        const stepInfo = this.config.martingale_enabled ? ` | Mart Step: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const r = this.regime;
        const score = r && r.valid ? r.safetyScore : 0;
        const pnr = r && r.valid ? (r.posteriorNonRep * 100).toFixed(1) + '%' : '?';

        logTrade(
            `🎯 DIFFER from ${bold(cyan(this.targetDigit))} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo} | ` +
            `Rate: ${this.targetRepeatRate.toFixed(1)}% | ` +
            `Score: ${score}/100 | P(NR): ${pnr} | ` +
            `Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
        );

        this.sendTelegram(`
            🎯 <b>GHOST TRADE</b>

            📊 Symbol: ${this.config.symbol}
            🔢 Target Digit: ${this.targetDigit}
            last 5 ticks: ${this.tickHistory.slice(-5).join(', ')}
            💰 Stake: $${this.currentStake.toFixed(2)}${stepInfo}
            📈 Rate: ${this.targetRepeatRate.toFixed(1)}%
            🔬 Score: ${score}/100 | P(NR): ${pnr}
            👻 Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}
            📊 Session: ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
        `.trim());

        this.send({
            buy: 1,
            price: this.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: this.config.symbol,
                duration: 1,
                duration_unit: 't',
                basis: 'stake',
                amount: this.currentStake,
                barrier: String(this.targetDigit),
                currency: this.config.currency,
            },
        });
        this.botState = STATE.WAITING_RESULT;
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        const payout = parseFloat(msg.buy.payout);
        logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${payout.toFixed(2)}`));
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;
        this.botState = STATE.PROCESSING_RESULT;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;
        const resultDigit = this.tickHistory.length > 0 ? this.tickHistory[this.tickHistory.length - 1] : null;
        if (profit > 0) this.processWin(profit, resultDigit);
        else this.processLoss(this.lastBuyPrice, resultDigit);
        this.isTradeActive = false;
        this.decideNextAction();
    }

    processWin(profit, resultDigit) {
        this.totalWins++;
        this.sessionProfit += profit;
        this.currentWinStreak++;
        this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;

        // Reset BOCPD on win — fresh regime slate after a successful trade
        this.hmm.resetBOCPD();

        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        const recovery = this.martingaleStep > 0 ? green(' 🔄 RECOVERY!') : '';
        logResult(`${green('✅ WIN!')} Profit: ${green('+$' + profit.toFixed(2))} | P/L: ${plStr} | Bal: ${green('$' + this.accountBalance.toFixed(2))}${recovery}`);
        if (resultDigit !== null) logResult(dim(`  Target: ${this.targetDigit} | Result: ${resultDigit} | Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`));

        this.sendTelegram(`
            ✅ <b>WIN!</b>

            📊 Symbol: ${this.config.symbol}
            🎯 Target: ${this.targetDigit} | Result: ${resultDigit !== null ? resultDigit : 'N/A'}

            💰 Profit: +$${profit.toFixed(2)}
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 Balance: $${this.accountBalance.toFixed(2)}
            📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentWinStreak}W
            ⏰ ${new Date().toLocaleString()}
        `.trim());

        this.resetMartingale();
        this.resetGhost();
    }

    processLoss(lostAmount, resultDigit) {
        this.totalLosses++;
        this.sessionProfit -= lostAmount;
        this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++;
        this.currentWinStreak = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

        const martInfo = this.config.martingale_enabled ? ` | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${red('❌ LOSS!')} Lost: ${red('-$' + lostAmount.toFixed(2))} | P/L: ${plStr} | Bal: $${this.accountBalance.toFixed(2)}${martInfo}`);
        if (resultDigit !== null)
            logResult(dim(`  Target: ${this.targetDigit} | Result: ${resultDigit} (${resultDigit === this.targetDigit ? red('REPEATED') : green('different — unexpected loss')})`));

        this.sendTelegram(`
            ❌ <b>LOSS!</b>

            📊 Symbol: ${this.config.symbol}
            🎯 Target: ${this.targetDigit} | Result: ${resultDigit !== null ? resultDigit : 'N/A'}
            last 5 ticks: ${this.tickHistory.slice(-5).join(', ')}
            💸 Lost: -$${lostAmount.toFixed(2)}
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 Balance: $${this.accountBalance.toFixed(2)}
            📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentLossStreak}L${martInfo}
            👻 Ghost: Reset to 0
            ⏰ ${new Date().toLocaleString()}
        `.trim());

        this.ghostConsecutiveWins = 0;
        this.ghostConfirmed = false;
        this.ghostRoundsPlayed = 0;
        this.ghostAwaitingResult = false;
        logBot(dim(`Ghost wins reset. Waiting for digit ${bold(this.targetDigit)} (${this.config.ghost_wins_required} ghost win(s) required).`));
    }

    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }
        if (this.config.martingale_enabled && this.martingaleStep > 0 && this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`📈 Martingale recovery step ${this.martingaleStep}/${this.config.max_martingale_steps}...`));
            this.botState = this.config.ghost_enabled ? STATE.GHOST_TRADING : STATE.ANALYZING;
            if (!this.config.ghost_enabled) this.executeTradeFlow(false);
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`🛑 Max Martingale steps reached!`);
            this.resetMartingale();
            this.startCooldown();
            return;
        }
        this.botState = STATE.ANALYZING;
    }

    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) return this.config.base_stake;
        const raw = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
        const calc = Math.round(raw * 100) / 100;
        const final = Math.min(calc, this.config.max_stake);
        logBot(dim(`Mart calc: Step ${this.martingaleStep} | $${this.config.base_stake.toFixed(2)} × ${this.config.martingale_multiplier}^${this.martingaleStep} = $${calc.toFixed(2)} → Final: $${final.toFixed(2)}`));
        return final;
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\n${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🎯 Take profit reached! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\n${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🛑 Stop loss hit! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const nextStake = (!this.config.martingale_enabled || this.martingaleStep === 0)
            ? this.config.base_stake
            : Math.min(Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep) * 100) / 100, this.config.max_stake);
        if (nextStake > this.accountBalance) return { canTrade: false, reason: `💸 Next stake > balance`, action: 'STOP' };
        if (nextStake > this.config.max_stake) return { canTrade: false, reason: `📈 Next stake > max`, action: 'STOP' };
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: '🔄 Max Martingale steps reached.', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    resetMartingale() {
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = this.config.base_stake;
    }

    startCooldown() {
        this.botState = STATE.COOLDOWN;
        this.resetMartingale();
        this.resetGhost();
        const sec = this.config.cooldown_after_max_loss / 1000;
        logBot(`⏸️  Cooldown for ${sec}s...`);
        this.cooldownTimer = setTimeout(() => {
            if (this.botState === STATE.COOLDOWN) {
                logBot(green('▶️  Cooldown ended. Resuming...'));
                this.botState = STATE.ANALYZING;
            }
        }, this.config.cooldown_after_max_loss);
    }

    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping bot...')} Reason: ${reason}`);
        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.pendingTrade = false;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) {}
            setTimeout(() => { try { this.ws.close(); } catch (_) {} }, 500);
        }
        this.sendTelegram(`🛑 <b>SESSION STOPPED</b>\n\nReason: ${reason}\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                  ')));
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
        logStats(`  Symbol           : ${bold(this.config.symbol)}`);
        logStats(`  Analysis Method  : ${bold('HSMM + BOCPD + Entropy')}`);
        logStats(`  HMM NonRep Conf  : ${bold((this.config.hmm_nonrep_confidence * 100).toFixed(0) + '%')}`);
        logStats(`  BOCPD Min Run    : ${bold(this.config.bocpd_min_run_length + ' ticks')} @ ${bold((this.config.bocpd_run_confidence*100).toFixed(0) + '%')}`);
        logStats(`  Entropy Thres    : H>${bold(this.config.entropy_high)}(boost) H<${bold(this.config.entropy_low)}(block)`);
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
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();

    const bot = new RomanianGhostBot(config);

    process.on('SIGINT',  () => { console.log(''); bot.stop('SIGINT (Ctrl+C)'); });
    process.on('SIGTERM', () => { bot.stop('SIGTERM'); });
    process.on('uncaughtException', e => {
        logError(`Uncaught exception: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', reason => {
        logError(`Unhandled rejection: ${reason}`);
    });

    bot.start();
})();
