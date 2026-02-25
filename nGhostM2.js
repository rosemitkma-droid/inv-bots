// ============================================================================
// ROMANIAN GHOST BLACK FIBONACCI 9.2 ULTIMATE — FIXED & OPTIMIZED
// All logic bugs fixed + performance optimizations
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "rgNedekYXvCaPeP";
const TELEGRAM_TOKEN = "8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'ghost92-00018-state.json');

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// FIX #5: Loop-based max to prevent stack overflow on large arrays
function logSumExp(arr) {
    if (arr.length === 0) return -Infinity;
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] > m) m = arr[i];
    }
    if (!isFinite(m)) return -Infinity;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
        sum += Math.exp(arr[i] - m);
    }
    return m + Math.log(sum);
}

// Optimized 2-element version for hot paths (Viterbi, Forward)
function logSumExp2(a, b) {
    if (!isFinite(a) && !isFinite(b)) return -Infinity;
    const m = a > b ? a : b;
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

function formatMoney(v) {
    return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

// ── Logger helpers ─────────────────────────────────────────────────────────
function getTimestamp() {
    const n = new Date();
    return [
        String(n.getHours()).padStart(2, '0'),
        String(n.getMinutes()).padStart(2, '0'),
        String(n.getSeconds()).padStart(2, '0'),
    ].join(':');
}

const logHMM = (msg) => {
    console.log(`[${getTimestamp()}] [HMM] ${msg}`);
};

const logBot = (msg) => {
    console.log(`[${getTimestamp()}] [BOT] ${msg}`);
};

const logAnalysis = (msg) => {
    console.log(`[${getTimestamp()}] [ANALYSIS] ${msg}`);
};

// ══════════════════════════════════════════════════════════════════════════════
//  HMM REGIME DETECTOR — one instance per asset
//  2-State HMM: State 0 = NON-REP, State 1 = REP
// ══════════════════════════════════════════════════════════════════════════════
class HMMRegimeDetector {
    constructor(cfg) {
        this.cfg = cfg;
        // Initial HMM parameters (learned via Baum-Welch)
        this.pi = [0.6, 0.4];
        this.A = [[0.90, 0.10], [0.25, 0.75]];
        this.B = [[0.92, 0.08], [0.40, 0.60]]; // [state][obs]: obs=1 means repeat
        this.hmmFitted = false;
        this.cusumValue = new Array(10).fill(0); // per-digit CUSUM

        // FIX #3: Per-asset tick counter for Baum-Welch refit
        this.ticksSinceRefit = 0;

        // FIX #8 & #9: Pre-allocate reusable buffers for Baum-Welch
        // These get resized in baumWelch() if needed
        this._bwBuffersSize = 0;
        this._logAlpha = null;
        this._logBeta = null;
        this._logGamma = null;
        this._logXi = null;

        // Cache for last analysis result (throttling)
        this._lastAnalysisResult = null;
        this._analysisTickCounter = 0;
    }

    // ── Pre-allocate Baum-Welch buffers ───────────────────────────────────────
    _ensureBWBuffers(T) {
        if (this._bwBuffersSize >= T) return;
        const N = 2;
        this._logAlpha = new Array(T);
        this._logBeta = new Array(T);
        this._logGamma = new Array(T);
        this._logXi = new Array(T > 0 ? T - 1 : 0);
        for (let t = 0; t < T; t++) {
            this._logAlpha[t] = new Float64Array(N);
            this._logBeta[t] = new Float64Array(N);
            this._logGamma[t] = new Float64Array(N);
        }
        for (let t = 0; t < T - 1; t++) {
            this._logXi[t] = [new Float64Array(N), new Float64Array(N)];
        }
        this._bwBuffersSize = T;
    }

    // ── Baum-Welch EM parameter estimation (optimized) ───────────────────────
    baumWelch(obs, maxIter = 20, tol = 1e-5) {
        const T = obs.length;
        if (T < 10) return false;
        const N = 2;

        // FIX #8: Reuse pre-allocated buffers
        this._ensureBWBuffers(T);
        const logAlpha = this._logAlpha;
        const logBeta = this._logBeta;
        const logGamma = this._logGamma;
        const logXi = this._logXi;

        let pi = [...this.pi];
        let A = this.A.map(r => [...r]);
        let B = this.B.map(r => [...r]);
        let prevLogL = -Infinity;

        // Pre-compute log values to avoid repeated Math.log calls
        const logPi = [0, 0];
        const logA = [[0, 0], [0, 0]];
        const logB = [[0, 0], [0, 0]];

        for (let iter = 0; iter < maxIter; iter++) {
            // Cache log values for this iteration
            for (let s = 0; s < N; s++) {
                logPi[s] = Math.log(pi[s] + 1e-300);
                for (let nx = 0; nx < N; nx++) logA[s][nx] = Math.log(A[s][nx] + 1e-300);
                for (let o = 0; o < 2; o++) logB[s][o] = Math.log(B[s][o] + 1e-300);
            }

            // Forward pass
            for (let s = 0; s < N; s++)
                logAlpha[0][s] = logPi[s] + logB[s][obs[0]];

            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    logAlpha[t][s] = logSumExp2(
                        logAlpha[t - 1][0] + logA[0][s],
                        logAlpha[t - 1][1] + logA[1][s]
                    ) + logB[s][obs[t]];
                }
            }

            const logL = logSumExp2(logAlpha[T - 1][0], logAlpha[T - 1][1]);

            // Backward pass
            logBeta[T - 1][0] = 0;
            logBeta[T - 1][1] = 0;
            for (let t = T - 2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    logBeta[t][s] = logSumExp2(
                        logA[s][0] + logB[0][obs[t + 1]] + logBeta[t + 1][0],
                        logA[s][1] + logB[1][obs[t + 1]] + logBeta[t + 1][1]
                    );
                }
            }

            // Gamma
            for (let t = 0; t < T; t++) {
                const den = logSumExp2(
                    logAlpha[t][0] + logBeta[t][0],
                    logAlpha[t][1] + logBeta[t][1]
                );
                for (let s = 0; s < N; s++)
                    logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - den;
            }

            // Xi
            for (let t = 0; t < T - 1; t++) {
                const den = logSumExp2(
                    logAlpha[t][0] + logBeta[t][0],
                    logAlpha[t][1] + logBeta[t][1]
                );
                for (let s = 0; s < N; s++) {
                    for (let nx = 0; nx < N; nx++) {
                        logXi[t][s][nx] = logAlpha[t][s] + logA[s][nx] +
                            logB[nx][obs[t + 1]] + logBeta[t + 1][nx] - den;
                    }
                }
            }

            // M-step: re-estimate pi
            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi[0] + pi[1];
            pi[0] /= piSum;
            pi[1] /= piSum;

            // M-step: re-estimate A (using loop instead of large array allocation)
            for (let s = 0; s < N; s++) {
                // Numerator and denominator computed incrementally
                let denAccum = -Infinity;
                const numAccum = [-Infinity, -Infinity];

                for (let t = 0; t < T - 1; t++) {
                    denAccum = logSumExp2(denAccum, logGamma[t][s]);
                    for (let nx = 0; nx < N; nx++) {
                        numAccum[nx] = logSumExp2(numAccum[nx], logXi[t][s][nx]);
                    }
                }

                for (let nx = 0; nx < N; nx++) {
                    A[s][nx] = Math.exp(numAccum[nx] - denAccum);
                }
                const rs = A[s][0] + A[s][1];
                A[s][0] /= rs;
                A[s][1] /= rs;
            }

            // M-step: re-estimate B (using loop instead of filter+map)
            for (let s = 0; s < N; s++) {
                let denAccum = -Infinity;
                const numAccum = [-Infinity, -Infinity];

                for (let t = 0; t < T; t++) {
                    denAccum = logSumExp2(denAccum, logGamma[t][s]);
                    numAccum[obs[t]] = logSumExp2(numAccum[obs[t]], logGamma[t][s]);
                }

                for (let o = 0; o < 2; o++) {
                    B[s][o] = Math.exp(numAccum[o] - denAccum);
                }
                const bs = B[s][0] + B[s][1];
                B[s][0] /= bs;
                B[s][1] /= bs;
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Ensure State 0 = NON-REP (lower repeat emission)
        if (B[0][1] > B[1][1]) {
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        this.pi = pi;
        this.A = A;
        this.B = B;
        this.hmmFitted = true;
        return true;
    }

    // ── Viterbi decoding ───────────────────────────────────────────────────────
    viterbi(obs) {
        const T = obs.length, N = 2;
        if (T === 0) return null;

        // Use typed arrays for performance
        const logDelta = new Array(T);
        const psi = new Array(T);
        for (let t = 0; t < T; t++) {
            logDelta[t] = new Float64Array(N);
            psi[t] = new Uint8Array(N);
        }

        const logB00 = Math.log(this.B[0][0] + 1e-300);
        const logB01 = Math.log(this.B[0][1] + 1e-300);
        const logB10 = Math.log(this.B[1][0] + 1e-300);
        const logB11 = Math.log(this.B[1][1] + 1e-300);
        const logBArr = [logB00, logB01, logB10, logB11]; // [s*2 + obs]

        const logA00 = Math.log(this.A[0][0] + 1e-300);
        const logA01 = Math.log(this.A[0][1] + 1e-300);
        const logA10 = Math.log(this.A[1][0] + 1e-300);
        const logA11 = Math.log(this.A[1][1] + 1e-300);

        // Init
        logDelta[0][0] = Math.log(this.pi[0] + 1e-300) + logBArr[obs[0]];
        logDelta[0][1] = Math.log(this.pi[1] + 1e-300) + logBArr[2 + obs[0]];

        // Recurse (unrolled for N=2)
        for (let t = 1; t < T; t++) {
            const o = obs[t];
            // State 0
            const v00 = logDelta[t - 1][0] + logA00;
            const v10 = logDelta[t - 1][1] + logA10;
            if (v00 >= v10) {
                logDelta[t][0] = v00 + logBArr[o];
                psi[t][0] = 0;
            } else {
                logDelta[t][0] = v10 + logBArr[o];
                psi[t][0] = 1;
            }
            // State 1
            const v01 = logDelta[t - 1][0] + logA01;
            const v11 = logDelta[t - 1][1] + logA11;
            if (v01 >= v11) {
                logDelta[t][1] = v01 + logBArr[2 + o];
                psi[t][1] = 0;
            } else {
                logDelta[t][1] = v11 + logBArr[2 + o];
                psi[t][1] = 1;
            }
        }

        // Backtrace
        const stateSeq = new Uint8Array(T);
        stateSeq[T - 1] = logDelta[T - 1][0] >= logDelta[T - 1][1] ? 0 : 1;
        for (let t = T - 2; t >= 0; t--) stateSeq[t] = psi[t + 1][stateSeq[t + 1]];

        const curState = stateSeq[T - 1];
        let persistence = 1;
        for (let t = T - 2; t >= 0; t--) {
            if (stateSeq[t] === curState) persistence++;
            else break;
        }
        let transitions = 0;
        for (let t = 1; t < T; t++) {
            if (stateSeq[t] !== stateSeq[t - 1]) transitions++;
        }

        return { stateSeq, currentState: curState, persistence, transitions };
    }

    // ── CUSUM change-point detector (FIX #1: single observation update) ───────
    updateCUSUM(digit, obs_t) {
        const llr = Math.log(this.B[1][obs_t] + 1e-300) - Math.log(this.B[0][obs_t] + 1e-300);
        this.cusumValue[digit] = Math.max(0, this.cusumValue[digit] + llr - this.cfg.cusum_slack);
        return this.cusumValue[digit] > this.cfg.cusum_threshold;
    }

    resetCUSUM(digit) { this.cusumValue[digit] = 0; }
    getCUSUMValue(digit) { return this.cusumValue[digit]; }

    // ── Per-digit stats (FIX #12: single pass) ───────────────────────────────
    computePerDigitStats(window) {
        const len = window.length;
        const ALPHA = 0.15;
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);
        const ewmaRepeat = new Array(10).fill(null);

        // Single pass for both EWMA and transition counting
        for (let i = 0; i < len; i++) {
            const d = window[i];
            const isRepeat = i > 0 && window[i] === window[i - 1];

            // EWMA update
            if (ewmaRepeat[d] === null) {
                ewmaRepeat[d] = isRepeat ? 100 : 0;
            } else {
                ewmaRepeat[d] = ALPHA * (isRepeat ? 100 : 0) + (1 - ALPHA) * ewmaRepeat[d];
            }

            // Transition counting (combine into same loop)
            if (i < len - 1) {
                transFrom[window[i]]++;
                if (window[i + 1] === window[i]) transRepeat[window[i]]++;
            }
        }

        const rawRepeatProb = new Array(10).fill(0);
        for (let d = 0; d < 10; d++) {
            rawRepeatProb[d] = transFrom[d] > 0 ? (transRepeat[d] / transFrom[d]) * 100 : 10;
            if (ewmaRepeat[d] === null) ewmaRepeat[d] = 10;
        }
        return { rawRepeatProb, ewmaRepeat };
    }

    // ── Full regime analysis (FIX #1, #7 optimizations) ──────────────────────
    analyze(tickHistory, targetDigit, asset) {
        // FIX #7: Throttle analysis — only run full analysis every 3 ticks
        this._analysisTickCounter++;
        if (this._analysisTickCounter < 3 && this._lastAnalysisResult !== null) {
            return this._lastAnalysisResult;
        }
        this._analysisTickCounter = 0;

        // FIX #8: Reduced analysis window (1000 instead of 5000)
        const windowSize = Math.min(this.cfg.analysis_window, tickHistory.length);
        const window = tickHistory.slice(-windowSize);
        const len = window.length;

        if (len < this.cfg.min_ticks_for_hmm) {
            this._lastAnalysisResult = {
                valid: false,
                reason: `Insufficient data (${len}/${this.cfg.min_ticks_for_hmm})`
            };
            return this._lastAnalysisResult;
        }

        // Binary observation: 1 = repeat, 0 = no repeat
        const obs = new Uint8Array(len - 1);
        for (let t = 1; t < len; t++) obs[t - 1] = window[t] === window[t - 1] ? 1 : 0;

        // FIX #3 & #9: Per-asset refit counter, increased interval
        this.ticksSinceRefit++;
        if (!this.hmmFitted || this.ticksSinceRefit >= 200) {
            const ok = this.baumWelch(obs);
            if (ok) {
                this.ticksSinceRefit = 0;
                logHMM(
                    `[${asset}] HMM refitted | ` +
                    `A[NR→NR]=${(this.A[0][0] * 100).toFixed(1)}% A[NR→R]=${(this.A[0][1] * 100).toFixed(1)}% ` +
                    `A[R→NR]=${(this.A[1][0] * 100).toFixed(1)}% A[R→R]=${(this.A[1][1] * 100).toFixed(1)}% | ` +
                    `B(rep|NR)=${(this.B[0][1] * 100).toFixed(1)}% B(rep|R)=${(this.B[1][1] * 100).toFixed(1)}%`
                );
            }
        }

        // Viterbi
        const vit = this.viterbi(obs);
        if (!vit) {
            this._lastAnalysisResult = { valid: false, reason: 'Viterbi failed' };
            return this._lastAnalysisResult;
        }

        // Forward (Bayesian posterior) — optimized with logSumExp2
        let logA0 = Math.log(this.pi[0] + 1e-300) + Math.log(this.B[0][obs[0]] + 1e-300);
        let logA1 = Math.log(this.pi[1] + 1e-300) + Math.log(this.B[1][obs[0]] + 1e-300);

        const logATrans = [
            [Math.log(this.A[0][0] + 1e-300), Math.log(this.A[0][1] + 1e-300)],
            [Math.log(this.A[1][0] + 1e-300), Math.log(this.A[1][1] + 1e-300)]
        ];
        const logBEmit = [
            [Math.log(this.B[0][0] + 1e-300), Math.log(this.B[0][1] + 1e-300)],
            [Math.log(this.B[1][0] + 1e-300), Math.log(this.B[1][1] + 1e-300)]
        ];

        for (let t = 1; t < obs.length; t++) {
            const o = obs[t];
            const new0 = logSumExp2(logA0 + logATrans[0][0], logA1 + logATrans[1][0]) + logBEmit[0][o];
            const new1 = logSumExp2(logA0 + logATrans[0][1], logA1 + logATrans[1][1]) + logBEmit[1][o];
            logA0 = new0;
            logA1 = new1;
        }
        const fwdDen = logSumExp2(logA0, logA1);
        const posteriorNonRep = Math.exp(logA0 - fwdDen);
        const posteriorRep = Math.exp(logA1 - fwdDen);

        // FIX #1: CUSUM — only process the SINGLE newest observation
        const lastObs = obs[obs.length - 1]; // newest observation
        const prevDigit = window[window.length - 2];
        const currDigit = window[window.length - 1];
        let cusumAlarm = false;
        if (prevDigit === targetDigit || currDigit === targetDigit) {
            cusumAlarm = this.updateCUSUM(targetDigit, lastObs);
        }
        const cusumValue = this.getCUSUMValue(targetDigit);

        // Per-digit stats
        const { rawRepeatProb, ewmaRepeat } = this.computePerDigitStats(window);

        // Regime stability: 5-segment analysis
        const seqLen = vit.stateSeq.length;
        const segSize = Math.floor(seqLen / 5);
        let stabilitySum = 0;
        let segCount = 0;
        for (let seg = 0; seg < 5 && seg * segSize < seqLen; seg++) {
            const start = seg * segSize;
            const end = Math.min((seg + 1) * segSize, seqLen);
            let nonRepCount = 0;
            for (let i = start; i < end; i++) {
                if (vit.stateSeq[i] === 0) nonRepCount++;
            }
            stabilitySum += nonRepCount / (end - start);
            segCount++;
        }
        const regimeStability = segCount > 0 ? stabilitySum / segCount : 0;

        // Composite safety score (0-100)
        const threshold = this.cfg.repeat_threshold;
        let safetyScore = 0;
        if (vit.currentState === 0) safetyScore += 40;
        safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 30);
        safetyScore += Math.round(clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1) * 15);
        safetyScore += Math.round(regimeStability * 15);

        // Hard gates
        if (vit.currentState !== 0) safetyScore = 0;
        if (posteriorNonRep < this.cfg.hmm_nonrep_confidence) safetyScore = Math.min(safetyScore, this.cfg.min_safety_score - 1);
        if (rawRepeatProb[targetDigit] >= threshold) safetyScore = 0;
        if (cusumAlarm) safetyScore = 0;

        // Signal condition
        const signalActive = (
            vit.currentState === 0 &&
            posteriorNonRep >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            rawRepeatProb[targetDigit] < threshold &&
            ewmaRepeat[targetDigit] < threshold &&
            !cusumAlarm &&
            safetyScore >= this.cfg.min_safety_score
        );

        this._lastAnalysisResult = {
            valid: true,
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            regimeStability,
            posteriorNonRep,
            posteriorRep,
            cusumAlarm,
            cusumValue,
            rawRepeatProb,
            ewmaRepeat,
            hmmA: this.A,
            hmmB: this.B,
            safetyScore,
            signalActive,
        };

        return this._lastAnalysisResult;
    }
}

class RomanianGhostUltimate {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
            assets: [
                'R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR',
            ],
            requiredHistoryLength: 5000,
            minHistoryForTrading: 5000,

            // ====== HMM REGIME DETECTION SETTINGS ======
            min_ticks_for_hmm: 50,
            repeat_threshold: 4, // % threshold for raw repeat probability per digit
            hmm_nonrep_confidence: 0.935,
            min_safety_score: 96,
            min_regime_persistence: 15,
            cusum_threshold: 15.5,
            cusum_slack: 0.005,
            // FIX #8: Reduced analysis window from 5000 to 1000
            analysis_window: 1000,

            // Money management
            baseStake: 0.61,
            firstLossMultiplier: 11.3,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 3,
            takeProfit: 10000,
            stopLoss: -50,
        };

        // ====== TRADING STATE ======
        this.histories = {};
        this.config.assets.forEach(a => this.histories[a] = []);

        this.stake = this.config.baseStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0; this.x3 = 0; this.x4 = 0; this.x5 = 0;
        this.netProfit = 0;

        this.lastTradeDigit = {};
        this.asset_safety_score = {};
        this.lastTradeTime = {};
        this.ticksSinceLastTrade = {};
        this.lastTickLogTime = {};
        this.lastTickLogTime2 = {};
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.isWinTrade = false;

        this.config.assets.forEach(a => {
            this.lastTradeDigit[a] = null;
            this.asset_safety_score[a] = null;
            this.lastTradeTime[a] = 0;
            this.ticksSinceLastTrade[a] = 999;
            this.lastTickLogTime[a] = 0;
            this.lastTickLogTime2[a] = 0;
        });

        this.assetHMMs = new Map();

        // Performance tracking
        this.recentTrades = [];
        this.maxRecentTrades = 50;

        // Hourly stats
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.historyLoaded = {};
        this.config.assets.forEach(a => this.historyLoaded[a] = false);

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.isReconnecting = false;

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // Load state & connect
        this.loadState();
        this.connect();
        this.startHourlySummary();
        this.startAutoSave();
    }

    // ========================================================================
    // WEBSOCKET & UTILITIES
    // ========================================================================
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.sendRequest({ authorize: TOKEN });
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (e) {
                console.error('Parse error:', e.message);
            }
        });

        this.ws.on('close', () => {
            this.connected = false;
            this.wsReady = false;
            if (!this.isReconnecting && this.reconnectAttempts < this.maxReconnectAttempts && !this.endOfDay) {
                this.reconnect();
            }
        });

        this.ws.on('error', (e) => console.error('WS Error:', e.message));
    }

    reconnect() {
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error('API Error:', msg.error.message);
            // FIX: Don't block trade progress on non-critical errors
            if (msg.msg_type === 'buy') {
                this.tradeInProgress = false;
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                console.log('✅ Authenticated');
                this.wsReady = true;
                this.initializeSubscriptions();
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'buy':
                if (!msg.error) {
                    this.sendRequest({
                        proposal_open_contract: 1,
                        contract_id: msg.buy.contract_id,
                        subscribe: 1
                    });
                } else {
                    this.tradeInProgress = false;
                }
                break;
            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(msg.proposal_open_contract);
                }
                break;
        }
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');
        this.config.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    sendRequest(req) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => { });
    }

    disconnect() {
        console.log('🛑 Disconnecting...');
        this.saveState();
        this.endOfDay = true;
        if (this.ws) this.ws.close();
    }

    // State persistence
    saveState() {
        try {
            const stateData = {
                savedAt: Date.now(),
                stake: this.stake,
                consecutiveLosses: this.consecutiveLosses,
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                x2: this.x2, x3: this.x3, x4: this.x4, x5: this.x5,
                netProfit: this.netProfit,
                recentTrades: this.recentTrades,
                lastTradeDigit: this.lastTradeDigit,
                lastTradeTime: this.lastTradeTime,
                ticksSinceLastTrade: this.ticksSinceLastTrade,
                accountBalance: this.accountBalance,
                startingBalance: this.startingBalance,
                sessionStartTime: this.sessionStartTime
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
        } catch (e) {
            console.error('Error saving state:', e.message);
        }
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

            if (Date.now() - data.savedAt > 30 * 60 * 1000) return;

            this.stake = data.stake || this.stake;
            this.consecutiveLosses = data.consecutiveLosses || 0;
            this.totalTrades = data.totalTrades || 0;
            this.totalWins = data.totalWins || 0;
            this.x2 = data.x2 || 0;
            this.x3 = data.x3 || 0;
            this.x4 = data.x4 || 0;
            this.x5 = data.x5 || 0;
            this.netProfit = data.netProfit || 0;
            this.recentTrades = data.recentTrades || [];

            if (data.lastTradeDigit) this.lastTradeDigit = data.lastTradeDigit;
            if (data.lastTradeTime) this.lastTradeTime = data.lastTradeTime;
            if (data.ticksSinceLastTrade) this.ticksSinceLastTrade = data.ticksSinceLastTrade;

            console.log('✅ State restored from ' + new Date(data.savedAt).toLocaleString());
        } catch (e) {
            console.error('Error loading state:', e.message);
        }
    }

    // FIX #11: Auto-save every 30 seconds instead of 5 seconds
    startAutoSave() {
        setInterval(() => this.saveState(), 30000);
    }

    startHourlySummary() {
        setInterval(() => {
            if (this.hourly.trades === 0) return;
            const winRate = ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1);
            this.sendTelegram(`
                ⏰ <b>HOURLY — GHOST Bot v1 Multi</b>

                📊 Trades: ${this.hourly.trades}
                ✅/❌ W/L: ${this.hourly.wins}/${this.hourly.losses}
                📈 Win Rate: ${winRate}%
                💰 P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

                📊 <b>Session</b>
                ├ Total: ${this.totalTrades}
                ├ W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
                ├ x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
                └ Net: $${this.netProfit.toFixed(2)}
            `.trim());
            // FIX #10: Single reset instead of duplicate
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];
        this.histories[asset] = prices.map(p => this.getLastDigit(p, asset));
        this.historyLoaded[asset] = true;

        if (!this.assetHMMs.has(asset)) {
            const cfg = {
                analysis_window: this.config.analysis_window,
                min_ticks_for_hmm: this.config.min_ticks_for_hmm,
                repeat_threshold: this.config.repeat_threshold,
                min_regime_persistence: this.config.min_regime_persistence,
                hmm_nonrep_confidence: this.config.hmm_nonrep_confidence,
                min_safety_score: this.config.min_safety_score,
                cusum_threshold: this.config.cusum_threshold,
                cusum_slack: this.config.cusum_slack
            };
            this.assetHMMs.set(asset, new HMMRegimeDetector(cfg));
        }

        console.log(`📊 Loaded ${this.histories[asset].length} ticks for ${asset} | HMM initialized`);
    }

    // ========================================================================
    // TICK HANDLING
    // ========================================================================
    handleTickUpdate(tick) {
        const asset = tick.symbol;
        if (!this.config.assets.includes(asset)) return;

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.histories[asset].push(lastDigit);
        if (this.histories[asset].length > this.config.requiredHistoryLength) {
            this.histories[asset].shift();
        }

        this.ticksSinceLastTrade[asset]++;

        // FIX #6: Throttled logging — every 30 seconds
        const now = Date.now();
        if (now - this.lastTickLogTime[asset] >= 30000) {
            console.log(`📈 [${asset}] Tick #${this.histories[asset].length} | Digit: ${lastDigit}`);
            console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
            this.lastTickLogTime[asset] = now;
        }

        if (this.historyLoaded[asset] && !this.tradeInProgress) {
            this.scanForSignal(asset);
        }
    }

    // ========================================================================
    // MAIN SIGNAL SCANNER (FIXED)
    // ========================================================================
    scanForSignal(asset) {
        if (this.tradeInProgress) return;

        const history = this.histories[asset];
        if (history.length < 50) return;

        const hmm = this.assetHMMs.get(asset);
        if (!hmm) return;

        // FIX #3: tickCount is now internal to each HMM instance
        // FIX #7: Throttling is now handled inside analyze()
        const regime = hmm.analyze(history, history[history.length - 1], asset);

        if (!regime.valid) return;
        if (!regime.signalActive) return;

        const targetDigit = history[history.length - 1];
        const safetyScore = regime.safetyScore;
        const hmmState = regime.hmmStateName;
        const confidence = regime.posteriorNonRep;

        // FIX #6: Time-gated logging restored
        const now = Date.now();
        if (now - this.lastTickLogTime2[asset] >= 30000) {
            console.log(
                `[${asset}] HMM=${hmmState} | Safety=${safetyScore} | ` +
                `Conf=${(confidence * 100).toFixed(1)}% | Persist=${regime.hmmPersistence} | ` +
                `RepRate=${regime.rawRepeatProb[targetDigit].toFixed(1)}% | CUSUM=${regime.cusumAlarm ? '⚠️' : '✓'}`
            );
            this.lastTickLogTime2[asset] = now;
        }

        // FIX #9: Removed redundant gating checks — signalActive already covers them
        // The signalActive flag in analyze() already checks:
        //   - hmmState === 0 (NON-REP)
        //   - posteriorNonRep >= confidence threshold
        //   - persistence >= min persistence
        //   - rawRepeatProb < threshold
        //   - ewmaRepeat < threshold
        //   - !cusumAlarm
        //   - safetyScore >= min_safety_score

        // FIX #2: Same-digit repeat guard — proper per-asset numeric comparison
        if (targetDigit === this.lastTradeDigit[asset]) {
            const currentConfidence = confidence * 100;
            const previousConfidence = parseFloat(this.asset_safety_score[asset]) || 0;
            const requiredConfidence = previousConfidence + 1; // require at least 1% higher confidence than last trade on same digit
            if (currentConfidence < requiredConfidence) {
                if (now - this.lastTickLogTime2[asset] >= 30000) {
                    console.log(
                        `[${asset}] Blocked - Same digit repeat: ` +
                        `current ${currentConfidence.toFixed(1)}% < required ${requiredConfidence.toFixed(1)}%`
                    );
                }
                return;
            }
        }

        this.placeTrade(asset, targetDigit, safetyScore, regime);
    }

    // ========================================================================
    // TRADE EXECUTION
    // ========================================================================
    placeTrade(asset, digit, safetyScore, regime) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.lastTradeDigit[asset] = digit;
        this.asset_safety_score[asset] = safetyScore;
        this.lastTradeTime[asset] = Date.now();
        this.ticksSinceLastTrade[asset] = 0;

        console.log(`\n🎯 TRADE SIGNAL — ${asset}`);
        console.log(`   Digit: ${digit}`);
        console.log(`   Safety Score: ${safetyScore}`);
        console.log(`   HMM State: ${regime.hmmStateName}`);
        console.log(`   Confidence: ${(regime.posteriorNonRep * 100).toFixed(1)}%`);
        console.log(`   Persistence: ${regime.hmmPersistence}`);
        console.log(`   Stake: $${this.stake.toFixed(2)}`);

        this.sendRequest({
            buy: 1,
            price: this.stake,
            parameters: {
                amount: this.stake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: asset,
                barrier: digit.toString()
            }
        });

        this.sendTelegram(`
            🎯 <b>TRADE OPENED V1 Multi</b>

            📊 Asset: ${asset}
            🔢 Target Digit: ${digit}
            📈 Last10: ${this.histories[asset].slice(-10).join(',')}
            🛡️ SafetyScore: ${safetyScore}
            💯 P(RNR): ${(regime.posteriorNonRep * 100).toFixed(1)}% | P(REP): ${(regime.posteriorRep * 100).toFixed(1)}%
            ⏱️ Persistence: ${regime.hmmPersistence}
            💰 Stake: $${this.stake.toFixed(2)}
            📊 Losses: ${this.consecutiveLosses}
        `.trim());
    }

    // ========================================================================
    // TRADE RESULT HANDLING (FIX #4: Martingale formula corrected)
    // ========================================================================
    handleTradeResult(contract) {
        const won = contract.status === "won";
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, asset);

        this.totalTrades++;
        this.hourly.trades++;
        this.hourly.pnl += profit;
        this.netProfit += profit;

        this.recentTrades.push({ won, profit, time: Date.now() });
        if (this.recentTrades.length > this.maxRecentTrades) {
            this.recentTrades.shift();
        }

        const resultMessage = won ? '✅ WIN' : '❌ LOSS';
        console.log(`\n${resultMessage} — ${asset}`);
        console.log(`   Target: ${this.lastTradeDigit[asset]}`);
        console.log(`   Safety Score: ${this.asset_safety_score[asset]}`);
        console.log(`   Exit Digit: ${exitDigit}`);
        console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Net P&L: $${this.netProfit.toFixed(2)}`);

        if (won) {
            this.totalWins++;
            this.hourly.wins++;
            this.consecutiveLosses = 0;
            this.stake = this.config.baseStake;
            this.isWinTrade = true;
        } else {
            this.isWinTrade = false;
            this.hourly.losses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;

            // FIX #4: Corrected Martingale recovery formula
            // Each level must recover ALL prior cumulative losses + generate base profit
            // Loss 1: stake = base * firstLossMultiplier (recovers base stake loss)
            // Loss 2+: stake = base * firstLossMultiplier * subsequentMultiplier^(losses-1)
            if (this.consecutiveLosses === 1) {
                this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            } else {
                this.stake = this.config.baseStake *
                    this.config.firstLossMultiplier *
                    Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            }
            this.stake = Math.round(this.stake * 100) / 100;
        }

        let telegramContent = `
            ${won ? '✅ <b>V1 MULTI-BOT WIN!</b>' : '❌ <b>V1 MULTI-BOT LOSS!</b>'}

            📊 Symbol: ${asset}
            🎯 Target: ${this.lastTradeDigit[asset]}
            🔢 Exit: ${exitDigit}
            📈 Last10: ${this.histories[asset].slice(-10).join(',')}
            🛡️ SafetyScoe: ${this.asset_safety_score[asset]}
            💰 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            💵 Balance: $${this.netProfit.toFixed(2)}
            📊 Record: ${this.totalWins}W/${this.totalTrades - this.totalWins}L | Losses: ${this.consecutiveLosses}${this.consecutiveLosses > 1 ? ` (x${this.consecutiveLosses})` : ''}
            📊 WIN RATE: ${((this.totalWins / this.totalTrades) * 100).toFixed(1)}%
            💲 Next Stake: $${this.stake.toFixed(2)}
        `;

        this.sendTelegram(telegramContent.trim());

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('🛑 Max consecutive losses reached');
            this.sendTelegram(`🛑 <b>MAX LOSSES REACHED!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        if (this.netProfit >= this.config.takeProfit) {
            console.log('🎉 Take profit reached!');
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        if (this.netProfit <= this.config.stopLoss) {
            console.log('🛑 Stop loss reached');
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            const isWeekend = (currentDay === 0) ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 8);

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension. Disconnecting...");
                    this.disconnect();
                    this.endOfDay = true;
                }
                return;
            }

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("Past 5:00 PM GMT+1 after a win trade, disconnecting.");
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.isWinTrade = false;
    }
}

// START
console.log('═══════════════════════════════════════════════════');
console.log('  ROMANIAN GHOST BLACK FIBONACCI 9.2 ULTIMATE');
console.log('  (FIXED & OPTIMIZED)');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new RomanianGhostUltimate();
