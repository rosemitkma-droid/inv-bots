#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v2.0 Advanced Regime Detection
//  Deriv Digit Differ — HMM + CUSUM + Bayesian Regime Detection
//
//  UPGRADED REGIME ENGINE:
//    1. True 2-State HMM with Viterbi decoding (REP / NON-REP regimes)
//    2. Baum-Welch parameter estimation (learns emission probs from data)
//    3. CUSUM change-point detection (catches regime shifts fast)
//    4. Bayesian posterior regime probability (confidence scoring)
//    5. Forward algorithm for real-time regime probability updates
//    6. Per-digit conditional emission model (not global)
//    7. Regime persistence scoring (how stable is the current regime)
//
//  TRADE CONDITION: Only fire when ALL hold:
//    a) HMM Viterbi → current regime = NON-REP (high confidence)
//    b) Bayesian posterior P(NON-REP | observations) ≥ 0.85
//    c) CUSUM shows NO recent shift INTO rep regime
//    d) Per-digit conditional repeat prob < threshold
//    e) Regime persistence score ≥ min_persistence ticks
//
//  Usage:
//    node romanian-ghost-bot-v2.js --token YOUR_DERIV_API_TOKEN [options]
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { stubFalse } = require('lodash');

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
        symbol: 'R_75',
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // History & analysis
        tick_history_size: 5000,
        analysis_window: 5000,          // HMM training window
        min_ticks_for_hmm: 50,         // Minimum ticks before HMM is reliable

        // Regime detection thresholds
        repeat_threshold: 9,           // Raw per-digit repeat % gate
        repeat_confidence: 90,        // Bayesian P(repeat | observations) required
        hmm_nonrep_confidence: 0.90,   // Bayesian P(NON-REP) required
        min_regime_persistence: 8,     // Ticks current regime must have lasted
        cusum_threshold: 4.5,          // CUSUM alarm threshold (regime shift detector)
        cusum_slack: 0.005,            // CUSUM slack (sensitivity tuning)

        // Ghost trading
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
//  ADVANCED REGIME DETECTION ENGINE
//
//  2-STATE HIDDEN MARKOV MODEL
//  ─────────────────────────────
//  States:  S0 = NON-REP  (digit is unlikely to repeat next tick)
//           S1 = REP      (digit is likely to repeat next tick)
//
//  Observations: For a target digit d at tick t, the observable is:
//    o_t = 1 if ticks[t] === ticks[t-1]  (a repeat occurred)
//    o_t = 0 otherwise                    (no repeat)
//
//  This gives a binary observation sequence we model with HMM.
//
//  Parameters (learned via Baum-Welch on tick history):
//    π  = initial state distribution [P(S0), P(S1)]
//    A  = transition matrix [[P(S0→S0), P(S0→S1)], [P(S1→S0), P(S1→S1)]]
//    B  = emission probs:  B[s][o]
//         B[0][1] = P(repeat | NON-REP state)   (should be low, ~0.05-0.15)
//         B[1][1] = P(repeat | REP state)        (should be high, ~0.5-0.9)
//
//  VITERBI DECODING
//  ─────────────────
//  Finds the most likely hidden state sequence.
//  Last state in sequence = current regime.
//
//  FORWARD ALGORITHM (real-time)
//  ──────────────────────────────
//  Incrementally updated on each new tick.
//  Gives P(state=S0 | all observations so far) — Bayesian posterior.
//
//  CUSUM CHANGE-POINT DETECTION
//  ─────────────────────────────
//  Tracks cumulative sum of log-likelihood ratio:
//    LLR_t = log P(o_t | S1) / P(o_t | S0)
//  When CUSUM_t = max(0, CUSUM_{t-1} + LLR_t - slack) > threshold:
//    → A shift FROM non-rep TO rep has been detected recently.
//    → Block all trades until CUSUM falls back below threshold.
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

        // Forward vector [alpha_0, alpha_1] (log-space)
        this.logAlpha = [Math.log(0.6), Math.log(0.4)];
        this.hmmFitted = false;

        // CUSUM per-digit
        this.cusumValue = new Array(10).fill(0);

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

        return true;
    }

    // ── Viterbi Decoding ──────────────────────────────────────────────────────
    // Returns most likely state sequence and regime info.
    viterbi(obs) {
        const T = obs.length;
        const N = 2;
        if (T === 0) return null;

        const logDelta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
        const psi      = Array.from({length: T}, () => new Array(N).fill(0));

        for (let s = 0; s < N; s++) {
            logDelta[0][s] = Math.log(this.pi[s] + 1e-300) + Math.log(this.B[s][obs[0]] + 1e-300);
        }

        for (let t = 1; t < T; t++) {
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bestPrev = 0;
                for (let prev = 0; prev < N; prev++) {
                    const v = logDelta[t-1][prev] + Math.log(this.A[prev][s] + 1e-300);
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

    // ── CUSUM Change-Point Detector ────────────────────────────────────────────
    // Detects sudden shift FROM non-rep TO rep regime.
    // Returns true if an alarm is active (regime shift detected recently).
    updateCUSUM(digit, obs_t) {
        // LLR: how much more likely is this observation under REP vs NON-REP
        const logLR = Math.log(this.B[1][obs_t] + 1e-300) - Math.log(this.B[0][obs_t] + 1e-300);
        this.cusumValue[digit] = Math.max(0, this.cusumValue[digit] + logLR - this.cfg.cusum_slack);
        return this.cusumValue[digit] > this.cfg.cusum_threshold;
    }

    resetCUSUM(digit) {
        this.cusumValue[digit] = 0;
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

        // ── CUSUM for target digit ─────────────────────────────────────────────
        // Build per-digit obs from last few ticks specifically for the target digit
        const recentLen = Math.min(len, 30);
        const recentWindow = window.slice(-recentLen);
        let cusumAlarm = false;
        for (let t = 1; t < recentLen; t++) {
            const obs_t = recentWindow[t] === recentWindow[t-1] ? 1 : 0;
            // Only update CUSUM on ticks where target digit appears
            if (recentWindow[t-1] === targetDigit || recentWindow[t] === targetDigit) {
                cusumAlarm = this.updateCUSUM(targetDigit, obs_t);
            }
        }

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

        // Component A: HMM Viterbi state (40 pts)
        if (vit.currentState === 0) safetyScore += 40;

        // Component B: Bayesian posterior confidence (30 pts)
        safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 30);

        // Component C: Regime persistence (15 pts)
        const persistenceScore = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
        safetyScore += Math.round(persistenceScore * 15);

        // Component D: Regime stability across segments (15 pts)
        safetyScore += Math.round(regimeStability * 15);

        // Hard gates: zero out if conditions fail
        if (vit.currentState !== 0) safetyScore = 0;              // Must be in NON-REP
        if (posteriorNonRep < this.cfg.hmm_nonrep_confidence) safetyScore = Math.min(safetyScore, 40); // confidence gate
        if (rawRepeatProb[targetDigit] >= threshold) safetyScore = 0;     // raw rate gate
        if (cusumAlarm) safetyScore = 0;                           // CUSUM alarm gate

        // ── Signal condition ───────────────────────────────────────────────────
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
            // HMM
            hmmState: vit.currentState,          // 0=NON-REP, 1=REP
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            regimeStability,
            // Bayesian
            posteriorNonRep,
            posteriorRep,
            // CUSUM
            cusumAlarm,
            cusumValue: this.cusumValue[targetDigit],
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
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v2.0  —  Deriv Digit Differ          ')));
        console.log(bold(cyan('   Advanced HMM Regime Detection + Bayesian + CUSUM             ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log(`  Symbol            : ${bold(c.symbol)}`);
        console.log(`  Base Stake        : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window   : ${bold(c.analysis_window)} ticks`);
        console.log(`  HMM Min Ticks     : ${bold(c.min_ticks_for_hmm)}`);
        console.log(`  Repeat Threshold  : ${bold(c.repeat_threshold + '%')}`);
        console.log(`  HMM NonRep Conf   : ${bold((c.hmm_nonrep_confidence * 100).toFixed(0) + '%')} posterior required`);
        console.log(`  Min Persistence   : ${bold(c.min_regime_persistence)} ticks in NON-REP regime`);
        console.log(`  CUSUM Threshold   : ${bold(c.cusum_threshold)} (shift detector)`);
        console.log(`  Ghost Trading     : ${c.ghost_enabled ? green('ON') + ` | Wins Required: ${bold(c.ghost_wins_required)}` : red('OFF')}`);
        console.log(`  Martingale        : ${c.martingale_enabled ? green('ON') + ` | Max Steps: ${c.max_martingale_steps} | Mult: ${c.martingale_multiplier}x` : red('OFF')}`);
        console.log(`  Take Profit       : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss         : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log('');
        console.log(bold(yellow('  REGIME DETECTION ENGINE:')));
        console.log(dim('  1. Baum-Welch HMM parameter estimation (re-fits every 50 ticks)'));
        console.log(dim('  2. Viterbi decoding → most likely regime sequence'));
        console.log(dim('  3. Forward algorithm → Bayesian P(NON-REP | all history)'));
        console.log(dim('  4. CUSUM change-point → detects sudden shift to REP regime'));
        console.log(dim('  5. Regime persistence → blocks trades in freshly-entered regimes'));
        console.log(dim('  6. Multi-segment stability → checks regime consistency over window'));
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
            `CUSUM: ${r.cusumAlarm ? red('⚠️ ALARM ' + r.cusumValue.toFixed(2)) : green('OK ' + r.cusumValue.toFixed(2))}`
        );

        logHMM(
            `HMM: B(rep|NR)=${(r.hmmB[0][1]*100).toFixed(1)}% B(rep|R)=${(r.hmmB[1][1]*100).toFixed(1)}% | ` +
            `A(NR→R)=${(r.hmmA[0][1]*100).toFixed(1)}% A(R→NR)=${(r.hmmA[1][0]*100).toFixed(1)}% | ` +
            `Safety: ${r.safetyScore >= 85 ? green(r.safetyScore+'/100') : red(r.safetyScore+'/100')} | ` +
            `Recent(20t): ${r.recentRepeatRate.toFixed(1)}%`
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
                if (r.cusumAlarm) reasons.push(`CUSUM ALARM (${r.cusumValue.toFixed(2)})`);
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
        } 
        // else {
        //     this.pendingTrade = true;
        //     this.botState = STATE.GHOST_TRADING;
        //     logBot(`⚡ Recovery trade queued — waiting for digit ${bold(cyan(this.targetDigit))}`);
        // }
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

        // Reset CUSUM for target digit on win
        this.hmm.resetCUSUM(this.targetDigit);

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
        logStats(`  Analysis Method  : ${bold('HMM + Bayesian + CUSUM')}`);
        logStats(`  HMM NonRep Conf  : ${bold((this.config.hmm_nonrep_confidence * 100).toFixed(0) + '%')}`);
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
