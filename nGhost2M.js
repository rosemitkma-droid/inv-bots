// ============================================================================
// ROMANIAN GHOST BLACK FIBONACCI 9.2 ULTIMATE — NOVEMBER 2025
// INTEGRATED WITH ADVANCED REGIME DETECTION v3.1 (FIXED)
// BOCPD + Binary HMM + EWMA Stack + ACF + Structural Break + CUSUM Ensemble
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "DMylfkyce6VyZt7";
const TELEGRAM_TOKEN = "8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'nGhost2M-state000012.json');

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function logSumExp(arr) {
    if (arr.length === 0) return -Infinity;
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

// Fast two-element logSumExp (avoids array spread overhead on hot paths)
function logSumExp2(a, b) {
    if (!isFinite(a) && !isFinite(b)) return -Infinity;
    const m = a > b ? a : b;
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }

// Proper chi-squared CDF approximation (1 degree of freedom) via erf
function chi2cdf1(x) {
    if (x <= 0) return 0;
    return erf(Math.sqrt(x / 2));
}

function erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}

// Logger helpers
function getTimestamp() {
    const n = new Date();
    return [String(n.getHours()).padStart(2, '0'), String(n.getMinutes()).padStart(2, '0'), String(n.getSeconds()).padStart(2, '0')].join(':');
}
const logHMM = (msg) => console.log(`[${getTimestamp()}] [HMM] ${msg}`);
const logBot = (msg) => console.log(`[${getTimestamp()}] [BOT] ${msg}`);
const logAnalysis = (msg) => console.log(`[${getTimestamp()}] [ANALYSIS] ${msg}`);
const logBocpd = (msg) => console.log(`[${getTimestamp()}] [BOCPD] ${msg}`);
const logStatus = (msg) => console.log(`[${getTimestamp()}] [STATUS] ${msg}`);

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 1: BOCPD (Bayesian Online Changepoint Detection) — FIXED
//  Fix #1: logR stays in log-space across iterations
//  Fix #2: Predictive computed with prior params BEFORE posterior update
// ══════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard = config.bocpd_hazard;
        this.alpha0 = config.bocpd_prior_alpha;
        this.beta0 = config.bocpd_prior_beta;
        this.threshold = config.bocpd_nonrep_confidence;
        this.minRun = config.bocpd_min_run_for_signal;

        // logR stays in LOG-SPACE permanently
        this.logR = [0]; // log(1) = 0
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];
        this.t = 0;
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
        this.modeRL = 0;
        this.thetaEstimate = this.alpha0 / (this.alpha0 + this.beta0);
        this.pChangepoint = 0.5;

        this.logHazard = Math.log(this.hazard);
        this.log1mHazard = Math.log(1 - this.hazard);

        // Pruning config
        this.MAX_RUN_LENGTHS = 300;
    }

    update(obs) {
        const ones = obs ? 1 : 0;
        const zeros = 1 - ones;
        const T = this.logR.length;

        const newLogR = new Array(T + 1);
        const newAlphas = new Array(T + 1);
        const newBetas = new Array(T + 1);

        // Growth probabilities: for each existing run length r,
        // compute predictive BEFORE updating sufficient stats (Fix #2)
        const changepointTerms = new Array(T);
        for (let r = 0; r < T; r++) {
            // Predictive with CURRENT (prior) params, not yet updated
            const predLog = this.betaLogPMF(ones, this.alphas[r], this.betas[r]);

            // Growth: run length r -> r+1
            newLogR[r + 1] = this.logR[r] + this.log1mHazard + predLog;

            // Accumulate changepoint mass
            changepointTerms[r] = this.logR[r] + this.logHazard + predLog;

            // NOW update sufficient stats for the grown run
            newAlphas[r + 1] = this.alphas[r] + ones;
            newBetas[r + 1] = this.betas[r] + zeros;
        }

        // Changepoint: new run length 0 (aggregate all changepoint mass)
        newLogR[0] = logSumExp(changepointTerms);
        newAlphas[0] = this.alpha0 + ones;
        newBetas[0] = this.beta0 + zeros;

        // Normalize in log-space (Fix #1: STAYS in log-space)
        const logNorm = logSumExp(newLogR);

        // Pruning: keep only top run lengths by probability mass
        if (newLogR.length > this.MAX_RUN_LENGTHS) {
            // Find threshold: keep entries within 40 log-units of max
            const logMax = Math.max(...newLogR);
            const cutoff = logMax - 40;
            const kept = [];
            for (let i = 0; i < newLogR.length; i++) {
                if (i === 0 || newLogR[i] > cutoff) {
                    kept.push(i);
                }
            }
            this.logR = kept.map(i => newLogR[i] - logNorm);
            this.alphas = kept.map(i => newAlphas[i]);
            this.betas = kept.map(i => newBetas[i]);
        } else {
            this.logR = newLogR.map(lr => lr - logNorm);
            this.alphas = newAlphas;
            this.betas = newBetas;
        }

        // Extract probabilities from normalized log-space
        this.pChangepoint = Math.exp(this.logR[0]);
        this.pNonRep = 1 - this.pChangepoint;

        // Expected run length
        this.expectedRunLength = 0;
        let maxLogP = -Infinity;
        this.modeRL = 0;
        for (let i = 0; i < this.logR.length; i++) {
            const p = Math.exp(this.logR[i]);
            this.expectedRunLength += i * p;
            if (this.logR[i] > maxLogP) {
                maxLogP = this.logR[i];
                this.modeRL = i;
            }
        }

        // Theta estimate from MAP run length
        const mapIdx = this.logR.indexOf(maxLogP);
        if (mapIdx >= 0 && mapIdx < this.alphas.length) {
            this.thetaEstimate = this.alphas[mapIdx] / (this.alphas[mapIdx] + this.betas[mapIdx]);
        }

        this.t++;

        return {
            pNonRep: this.pNonRep,
            expectedRL: this.expectedRunLength,
            modeRL: this.modeRL,
            thetaEstimate: this.thetaEstimate,
            pChangepoint: this.pChangepoint
        };
    }

    betaLogPMF(k, a, b) {
        // P(X=k | Beta(a,b)) for Bernoulli: P(1)=a/(a+b), P(0)=b/(a+b)
        return Math.log(k === 1 ? a : b) - Math.log(a + b);
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
        this.modeRL = 0;
        this.pChangepoint = 0.5;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 2: BINARY HMM — OPTIMIZED
//  Fix: Incremental forward updates, periodic Viterbi, reduced Baum-Welch window
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

        // Cached log parameters for fast forward updates
        this._cacheLogParams();

        // Incremental forward state
        this.posteriorNR = 0.65;
        this.posteriorRep = 0.35;
        this.forwardInitialized = false;

        // Periodic Viterbi cache
        this.cachedViterbi = null;
        this.ticksSinceViterbi = 0;
        this.VITERBI_INTERVAL = 15;
    }

    _cacheLogParams() {
        this.logA = this.A.map(row => row.map(v => Math.log(v + 1e-300)));
        this.logB = this.B.map(row => row.map(v => Math.log(v + 1e-300)));
        this.logPi = this.pi.map(v => Math.log(v + 1e-300));
    }

    buildObs(digitSeq) {
        const obs = new Array(digitSeq.length - 1);
        for (let t = 1; t < digitSeq.length; t++) obs[t - 1] = digitSeq[t] === digitSeq[t - 1] ? 1 : 0;
        return obs;
    }

    // O(1) incremental forward update — replaces full O(T) forward pass
    updateForward(obs_t) {
        const la = this.logAlpha;
        const s0 = logSumExp2(la[0] + this.logA[0][0], la[1] + this.logA[1][0]) + this.logB[0][obs_t];
        const s1 = logSumExp2(la[0] + this.logA[0][1], la[1] + this.logA[1][1]) + this.logB[1][obs_t];
        const d = logSumExp2(s0, s1);
        this.logAlpha = [s0 - d, s1 - d]; // Normalize to prevent underflow drift
        this.posteriorNR = Math.exp(s0 - d);
        this.posteriorRep = Math.exp(s1 - d);
        this.forwardInitialized = true;
        return [this.posteriorNR, this.posteriorRep];
    }

    // Reset forward to priors (call after Baum-Welch refit)
    resetForward() {
        this.logAlpha = [...this.logPi];
        this.posteriorNR = this.pi[0];
        this.posteriorRep = this.pi[1];
        this.forwardInitialized = false;
    }

    // Run forward from scratch over a short warm-up sequence
    warmUpForward(obsSeq) {
        this.logAlpha = [...this.logPi];
        for (let t = 0; t < obsSeq.length; t++) {
            this.updateForward(obsSeq[t]);
        }
        this.forwardInitialized = true;
    }

    // Baum-Welch — now operates on REDUCED window (max 500 obs)
    baumWelch(obs, maxIter = 20, tol = 1e-5) {
        // Use only last 500 observations for fitting
        const MAX_FIT_WINDOW = 500;
        if (obs.length > MAX_FIT_WINDOW) {
            obs = obs.slice(-MAX_FIT_WINDOW);
        }

        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };

        let pi = [...this.pi], A = this.A.map(r => [...r]), B = this.B.map(r => [...r]), prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            // Forward
            const logAlpha = new Array(T);
            logAlpha[0] = [
                Math.log(pi[0] + 1e-300) + Math.log(B[0][obs[0]] + 1e-300),
                Math.log(pi[1] + 1e-300) + Math.log(B[1][obs[0]] + 1e-300)
            ];
            for (let t = 1; t < T; t++) {
                logAlpha[t] = new Array(N);
                for (let s = 0; s < N; s++) {
                    logAlpha[t][s] = logSumExp2(
                        logAlpha[t - 1][0] + Math.log(A[0][s] + 1e-300),
                        logAlpha[t - 1][1] + Math.log(A[1][s] + 1e-300)
                    ) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }
            const logL = logSumExp2(logAlpha[T - 1][0], logAlpha[T - 1][1]);

            // Backward
            const logBeta = new Array(T);
            logBeta[T - 1] = [0, 0];
            for (let t = T - 2; t >= 0; t--) {
                logBeta[t] = new Array(N);
                for (let s = 0; s < N; s++) {
                    logBeta[t][s] = logSumExp2(
                        Math.log(A[s][0] + 1e-300) + Math.log(B[0][obs[t + 1]] + 1e-300) + logBeta[t + 1][0],
                        Math.log(A[s][1] + 1e-300) + Math.log(B[1][obs[t + 1]] + 1e-300) + logBeta[t + 1][1]
                    );
                }
            }

            // Gamma
            const logGamma = new Array(T);
            for (let t = 0; t < T; t++) {
                const d = logSumExp2(logAlpha[t][0] + logBeta[t][0], logAlpha[t][1] + logBeta[t][1]);
                logGamma[t] = [logAlpha[t][0] + logBeta[t][0] - d, logAlpha[t][1] + logBeta[t][1] - d];
            }

            // Xi
            const logXiSum = [[- Infinity, -Infinity], [-Infinity, -Infinity]]; // Accumulated xi
            for (let t = 0; t < T - 1; t++) {
                const d = logSumExp2(logAlpha[t][0] + logBeta[t][0], logAlpha[t][1] + logBeta[t][1]);
                for (let s = 0; s < N; s++) {
                    for (let nx = 0; nx < N; nx++) {
                        const v = logAlpha[t][s] + Math.log(A[s][nx] + 1e-300) +
                            Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx] - d;
                        logXiSum[s][nx] = logSumExp2(logXiSum[s][nx], v);
                    }
                }
            }

            // Re-estimate pi
            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi[0] + pi[1];
            pi[0] /= piSum; pi[1] /= piSum;

            // Re-estimate A
            for (let s = 0; s < N; s++) {
                // Accumulate gamma sum for s over t=0..T-2
                let denomParts = -Infinity;
                for (let t = 0; t < T - 1; t++) {
                    denomParts = logSumExp2(denomParts, logGamma[t][s]);
                }
                for (let nx = 0; nx < N; nx++) {
                    A[s][nx] = Math.exp(logXiSum[s][nx] - denomParts);
                }
                const rs = A[s][0] + A[s][1];
                A[s][0] /= rs; A[s][1] /= rs;
            }

            // Re-estimate B
            for (let s = 0; s < N; s++) {
                let denomParts = -Infinity;
                const numerParts = [-Infinity, -Infinity]; // For obs=0 and obs=1
                for (let t = 0; t < T; t++) {
                    denomParts = logSumExp2(denomParts, logGamma[t][s]);
                    numerParts[obs[t]] = logSumExp2(numerParts[obs[t]], logGamma[t][s]);
                }
                for (let o = 0; o < O; o++) {
                    B[s][o] = isFinite(numerParts[o]) ? Math.exp(numerParts[o] - denomParts) : 1e-10;
                }
                const bsum = B[s][0] + B[s][1];
                B[s][0] /= bsum; B[s][1] /= bsum;
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Label identification: state 0 = non-repeat, state 1 = repeat
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
                accepted: false, discrimination,
                repeatNR: B[0][1], repeatREP: B[1][1],
                reason: `discrimination ${(discrimination * 100).toFixed(1)}% < ${(this.MIN_DISCRIM * 100).toFixed(0)}%`
            };
        }

        this.pi = pi; this.A = A; this.B = B;
        this.fitted = true;
        this.lastFitDiscrim = discrimination;
        this._cacheLogParams();

        return { accepted: true, discrimination, repeatNR: B[0][1], repeatREP: B[1][1] };
    }

    // Viterbi — now runs on reduced window and is cached
    viterbi(obs) {
        // Use only last 200 observations for Viterbi (sufficient for regime detection)
        const MAX_VITERBI_WINDOW = 200;
        if (obs.length > MAX_VITERBI_WINDOW) {
            obs = obs.slice(-MAX_VITERBI_WINDOW);
        }

        const T = obs.length, N = 2;
        if (T === 0) return null;

        const logDelta = new Array(T);
        const psi = new Array(T);

        logDelta[0] = [this.logPi[0] + this.logB[0][obs[0]], this.logPi[1] + this.logB[1][obs[0]]];
        psi[0] = [0, 0];

        for (let t = 1; t < T; t++) {
            logDelta[t] = new Array(N);
            psi[t] = new Array(N);
            for (let s = 0; s < N; s++) {
                const v0 = logDelta[t - 1][0] + this.logA[0][s];
                const v1 = logDelta[t - 1][1] + this.logA[1][s];
                if (v0 >= v1) {
                    logDelta[t][s] = v0 + this.logB[s][obs[t]];
                    psi[t][s] = 0;
                } else {
                    logDelta[t][s] = v1 + this.logB[s][obs[t]];
                    psi[t][s] = 1;
                }
            }
        }

        const seq = new Array(T);
        seq[T - 1] = logDelta[T - 1][0] >= logDelta[T - 1][1] ? 0 : 1;
        for (let t = T - 2; t >= 0; t--) seq[t] = psi[t + 1][seq[t + 1]];

        const cur = seq[T - 1];
        let persistence = 1;
        for (let t = T - 2; t >= 0; t--) {
            if (seq[t] === cur) persistence++;
            else break;
        }
        let transitions = 0;
        for (let t = 1; t < T; t++) if (seq[t] !== seq[t - 1]) transitions++;

        return { stateSeq: seq, currentState: cur, persistence, transitions };
    }

    // Check if Viterbi needs re-running
    needsViterbiUpdate() {
        this.ticksSinceViterbi++;
        return this.ticksSinceViterbi >= this.VITERBI_INTERVAL || this.cachedViterbi === null;
    }

    repeatEmission(state) { return this.B[state][1]; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 3: MULTI-SCALE EWMA STACK (unchanged — already O(1))
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
//  COMPONENT 4: LAG AUTOCORRELATION — OPTIMIZED (uses pre-maintained buffer)
// ══════════════════════════════════════════════════════════════════════════════
function computeACF(seq, maxLag = 5) {
    const n = seq.length;
    if (n < maxLag + 2) return new Array(maxLag).fill(0);
    const mean = seq.reduce((s, v) => s + v, 0) / n;
    const variance = seq.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    if (variance < 1e-10) return new Array(maxLag).fill(0);
    const acf = new Array(maxLag);
    for (let lag = 1; lag <= maxLag; lag++) {
        let cov = 0;
        for (let t = 0; t < n - lag; t++) cov += (seq[t] - mean) * (seq[t + lag] - mean);
        acf[lag - 1] = cov / ((n - lag) * variance);
    }
    return acf;
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 5: STRUCTURAL BREAK DETECTOR — FIXED chi² CDF
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
        const pc = clamp(p, 1e-10, 1 - 1e-10);
        return k * Math.log(pc) + (n - k) * Math.log(1 - pc);
    }
    const llAlt = logLik(k1, n1, p1) + logLik(k2, n2, p2);
    const llNull = logLik(k1 + k2, n1 + n2, pPool);
    const lrtStat = Math.max(0, 2 * (llAlt - llNull));

    // Fix: proper chi-squared CDF with 1 degree of freedom
    const pValue = chi2cdf1(lrtStat);
    const pBreak = p2 > p1 ? pValue : 0;

    return { lrtStat, pBreak, rateOld: p1, rateNew: p2 };
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 6: TWO-SIDED CUSUM — FIXED logLR epsilon placement
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
        const pObs_H1 = isRepeat ? p1 : (1 - p1);
        const pObs_H0 = isRepeat ? p0 : (1 - p0);
        const logLR = Math.log((pObs_H1 + 1e-300) / (pObs_H0 + 1e-300));

        this.upC[digit] = Math.max(0, this.upC[digit] + logLR - this.slack);
        this.downC[digit] = Math.min(0, this.downC[digit] + logLR + this.slack);
        this.globalUp = Math.max(0, this.globalUp + logLR - this.slack);
        this.globalDown = Math.min(0, this.globalDown + logLR + this.slack);
    }

    resetDigit(d) { this.upC[d] = 0; this.downC[d] = 0; }
    resetGlobal() { this.globalUp = 0; this.globalDown = 0; }
    upAlarm(digit) { return this.upC[digit] > this.upThr || this.globalUp > this.upThr; }
    downConfirmed(digit) { return this.downC[digit] < this.downThr && this.globalDown < this.downThr; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  INCREMENTAL PER-DIGIT REPEAT RATE TRACKER (replaces O(N) full scan)
// ══════════════════════════════════════════════════════════════════════════════
class IncrementalDigitRepeatTracker {
    constructor(windowSize = 5000) {
        this.windowSize = windowSize;
        this.transFrom = new Array(10).fill(0);    // Count of transitions FROM digit d
        this.transRepeat = new Array(10).fill(0);  // Count of repeats FROM digit d
        this.pairBuffer = [];                       // Circular buffer of {from, repeated} pairs
    }

    update(prevDigit, curDigit) {
        const repeated = prevDigit === curDigit ? 1 : 0;

        // Add new pair
        this.transFrom[prevDigit]++;
        this.transRepeat[prevDigit] += repeated;
        this.pairBuffer.push({ from: prevDigit, repeated });

        // Remove oldest if over window
        if (this.pairBuffer.length > this.windowSize) {
            const old = this.pairBuffer.shift();
            this.transFrom[old.from]--;
            this.transRepeat[old.from] -= old.repeated;
        }
    }

    getRates() {
        return this.transFrom.map((n, d) => n > 0 ? (this.transRepeat[d] / n) * 100 : 10);
    }

    getRate(digit) {
        return this.transFrom[digit] > 0 ? (this.transRepeat[digit] / this.transFrom[digit]) * 100 : 10;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN ENSEMBLE REGIME DETECTOR — REFACTORED
//  Fix: Incremental updates, periodic heavy computation, no redundant work
// ══════════════════════════════════════════════════════════════════════════════
class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.bocpd = new BOCPD(config);
        this.hmm = new BinaryHMM(config);
        this.ewma = new EWMAStack();
        this.cusum = new TwoSidedCUSUM(config);
        this.digitTracker = new IncrementalDigitRepeatTracker(config.analysis_window);

        this.repeatBuffer = [];
        this.REPEAT_BUFFER_MAX = 200; // Reduced from 500 — only used for ACF
        this.ACF_BUFFER_MAX = 200;

        this.weights = { bocpd: 1.0, hmm: 1.0, ewma: 1.0, acf: 0.7, structural: 0.6, cusum: 1.0 };

        this.ticksSinceRefit = 0;
        this.tickCount = 0;

        // Recent binary obs buffer for HMM warm-up after refit
        this.recentBinaryObs = [];
        this.RECENT_OBS_MAX = 500;

        // Cached analysis results (updated incrementally)
        this.cachedACF = new Array(5).fill(0);
        this.cachedBreakResult = { lrtStat: 0, pBreak: 0, rateOld: 0.1, rateNew: 0.1 };
        this.ticksSinceACF = 0;
        this.ticksSinceBreak = 0;
        this.ACF_INTERVAL = 10;
        this.BREAK_INTERVAL = 20;
    }

    tick(prevDigit, curDigit) {
        const isRepeat = prevDigit === curDigit;
        const obs_binary = isRepeat ? 1 : 0;

        // O(1) updates
        this.bocpd.update(obs_binary);
        this.ewma.update(obs_binary);
        this.cusum.update(prevDigit, isRepeat, 0.10, 0.40);
        this.digitTracker.update(prevDigit, curDigit);

        // Maintain repeat buffer for ACF and structural break (bounded)
        this.repeatBuffer.push(obs_binary);
        if (this.repeatBuffer.length > this.REPEAT_BUFFER_MAX) {
            this.repeatBuffer.shift();
        }

        // Maintain recent binary obs for HMM
        this.recentBinaryObs.push(obs_binary);
        if (this.recentBinaryObs.length > this.RECENT_OBS_MAX) {
            this.recentBinaryObs.shift();
        }

        // O(1) HMM forward update
        if (this.hmm.fitted) {
            this.hmm.updateForward(obs_binary);
        }

        this.ticksSinceRefit++;
        this.ticksSinceACF++;
        this.ticksSinceBreak++;
        this.tickCount++;

        // Periodic HMM refit (heavy — every N ticks, uses reduced window)
        if (!this.hmm.fitted || this.ticksSinceRefit >= this.cfg.hmm_refit_every) {
            const fitObs = this.recentBinaryObs; // Already bounded to 500
            const fitResult = this.hmm.baumWelch(fitObs);
            this.ticksSinceRefit = 0;
            if (fitResult?.accepted) {
                // logHMM(`📐 HMM fitted | Discrim:${(fitResult.discrimination * 100).toFixed(1)}% ✅`);
                // Warm up forward from last ~50 observations after refit
                const warmUpObs = this.recentBinaryObs.slice(-50);
                this.hmm.warmUpForward(warmUpObs);
            }
        }

        // Periodic ACF update
        if (this.ticksSinceACF >= this.ACF_INTERVAL) {
            this.cachedACF = computeACF(this.repeatBuffer, 5);
            this.ticksSinceACF = 0;
        }

        // Periodic structural break test
        if (this.ticksSinceBreak >= this.BREAK_INTERVAL) {
            const breakBuf = this.repeatBuffer.slice(-100);
            this.cachedBreakResult = structuralBreakTest(breakBuf);
            this.ticksSinceBreak = 0;
        }
    }

    analyze(targetDigit) {
        // No history array needed — all state is maintained incrementally

        if (this.tickCount < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: `insufficient data (${this.tickCount}/${this.cfg.min_ticks_for_analysis})` };
        }

        // Periodic Viterbi (the only remaining O(T) operation, on reduced window)
        if (this.hmm.needsViterbiUpdate() && this.hmm.fitted) {
            const viterbiObs = this.recentBinaryObs.slice(-200);
            this.hmm.cachedViterbi = this.hmm.viterbi(viterbiObs);
            this.hmm.ticksSinceViterbi = 0;
        }

        const vit = this.hmm.cachedViterbi;
        if (!vit) return { valid: false, reason: 'viterbi not ready' };

        // Use incremental forward posteriors (O(1), already computed in tick())
        const posteriorNR = this.hmm.posteriorNR;
        const posteriorRep = this.hmm.posteriorRep;

        // O(1) per-digit repeat rates from incremental tracker
        const rawRepeatProb = this.digitTracker.getRates();

        // Use cached ACF and structural break results
        const acf = this.cachedACF;
        const breakResult = this.cachedBreakResult;

        // BOCPD results (already updated in tick())
        const bocpd = {
            pNonRep: this.bocpd.pNonRep,
            expectedRL: this.bocpd.expectedRunLength,
            modeRL: this.bocpd.modeRL,
            thetaEstimate: this.bocpd.thetaEstimate,
            pChangepoint: this.bocpd.pChangepoint
        };

        // EWMA values (already updated in tick())
        const ewmaValues = [0, 1, 2, 3].map(i => this.ewma.get(i));
        const ewmaTrend = this.ewma.trend();

        // CUSUM (already updated in tick())
        const cusumUpAlarm = this.cusum.upAlarm(targetDigit);
        const cusumDownConfirm = this.cusum.downConfirmed(targetDigit);

        // ── ENSEMBLE SCORING (0–100) ──
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
            const posterior = clamp((posteriorNR - 0.5) / 0.5, 0, 1);
            return ((persist * 0.6 + posterior * 0.4) * 25) * w.hmm;
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

        // Hard gates
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
            valid: true, hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence, hmmTransitions: vit.transitions,
            posteriorNR, posteriorRep,
            hmmA: this.hmm.A, hmmB_repeatNR: this.hmm.repeatEmission(0),
            hmmB_repeatREP: this.hmm.repeatEmission(1),
            hmmDiscrim: this.hmm.lastFitDiscrim,
            bocpdPNonRep: bocpd.pNonRep, bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL, bocpdTheta: bocpd.thetaEstimate,
            bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(),
            ewmaValues, ewmaTrend, acf, structBreak: breakResult,
            cusumUpAlarm, cusumDownConfirm,
            cusumUp: this.cusum.upC[targetDigit],
            cusumDown: this.cusum.downC[targetDigit],
            cusumGlobalUp: this.cusum.globalUp,
            rawRepeatProb, recentRate: this.ewma.get(0), // Use EWMA ultra-short instead of manual calc
            componentScores: { bocpdScore, hmmScore, ewmaScore, acfScore, breakScore, cusumScore },
            safetyScore, signalActive,
        };
    }

    applyTradeFeedback(won, regime) {
        if (!regime || !regime.valid) return;
        const decay = 0.85, restore = 1.02;
        if (!won) {
            for (const key of Object.keys(this.weights)) {
                this.weights[key] = Math.max(0.5, this.weights[key] * decay);
            }
        } else {
            for (const key of Object.keys(this.weights)) {
                this.weights[key] = Math.min(1.0, this.weights[key] * restore);
            }
        }
    }

    resetCUSUM(digit) { this.cusum.resetDigit(digit); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN BOT CLASS — REFACTORED
//  Fix: Per-asset detectors, no redundant analysis, clean state management
// ══════════════════════════════════════════════════════════════════════════════
class RomanianGhostUltimate {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
            assets: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'],
            requiredHistoryLength: 5000,
            minHistoryForTrading: 5000,

            // BOCPD
            bocpd_hazard: 1 / 150,
            bocpd_prior_alpha: 1,
            bocpd_prior_beta: 9,
            bocpd_nonrep_confidence: 0.82,
            bocpd_min_run_for_signal: 15,

            // HMM
            hmm_min_discrimination: 0.10,
            hmm_refit_every: 50,
            hmm_nonrep_confidence: 0.88,
            min_regime_persistence: 15,

            // EWMA
            ewma_trend_threshold: 2.0,

            // ACF
            acf_lag1_threshold: 0.15,

            // Structural break
            structural_break_threshold: 0.15,

            // CUSUM
            cusum_slack: 0.005,
            cusum_up_threshold: 15.5,
            cusum_down_threshold: -15.5,

            // General
            analysis_window: 100,
            min_ticks_for_analysis: 50,
            repeat_threshold: 9,
            repeat_confidence: 73,//70

            // Money management
            baseStake: 5.3,
            firstLossMultiplier: 11.3,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 3,
            takeProfit: 2.5,
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

        // FIX #3: Per-asset detectors instead of shared
        this.detectors = {};
        this.config.assets.forEach(a => {
            this.detectors[a] = null; // Initialized after history loads
        });

        this.tickCount = 0;

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
        // this.loadState();
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
            // Unblock trade on buy error
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
                this.sendRequest({
                    proposal_open_contract: 1,
                    contract_id: msg.buy.contract_id,
                    subscribe: 1
                });
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

    startAutoSave() {
        setInterval(() => this.saveState(), 5000);
    }

    startHourlySummary() {
        setInterval(() => {
            if (this.hourly.trades === 0) return;
            const winRate = ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1);
            this.sendTelegram(`
                ⏰ <b>HOURLY — GHOST Bot ENSEMBLE v2 Multi</b>

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

        // FIX #3: Create per-asset detector
        if (!this.detectors[asset]) {
            this.detectors[asset] = new AdvancedRegimeDetector(this.config);
            logBocpd(`🚀 Detector initialized for ${asset} with 6-component ensemble`);
        }

        // Warm up the detector with historical data
        const detector = this.detectors[asset];
        const history = this.histories[asset];
        for (let i = 1; i < history.length; i++) {
            detector.tick(history[i - 1], history[i]);
        }
        logBocpd(`📊 ${asset}: Warmed up detector with ${history.length} historical ticks`);

        console.log(`📊 Loaded ${history.length} ticks for ${asset}`);
    }

    // ========================================================================
    // TICK HANDLING — STREAMLINED
    // ========================================================================
    handleTickUpdate(tick) {
        const asset = tick.symbol;
        if (!this.config.assets.includes(asset)) return;

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.histories[asset].push(lastDigit);
        if (this.histories[asset].length > this.config.requiredHistoryLength) {
            this.histories[asset].shift();
        }

        // Feed per-asset detector with O(1) incremental update
        const detector = this.detectors[asset];
        if (detector && this.histories[asset].length >= 2) {
            const prevDigit = this.histories[asset][this.histories[asset].length - 2];
            detector.tick(prevDigit, lastDigit);
        }

        this.ticksSinceLastTrade[asset]++;

        // LOG EVERY 30 SECONDS
        const now = Date.now();
        if (now - this.lastTickLogTime[asset] >= 30000) {
            console.log(`📈 [${asset}] Tick #${this.histories[asset].length} | Digit: ${lastDigit}`);
            console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
            this.lastTickLogTime[asset] = now;
        }

        // Scan for signals
        if (this.historyLoaded[asset] && !this.tradeInProgress) {
            this.scanForSignal(asset);
        }
    }

    // ========================================================================
    // MAIN SIGNAL SCANNER — USES INCREMENTAL ANALYSIS
    // ========================================================================
    scanForSignal(asset) {
        if (this.tradeInProgress) return;

        const history = this.histories[asset];
        if (history.length < this.config.min_ticks_for_analysis) return;

        const detector = this.detectors[asset];
        if (!detector) return;

        const targetDigit = history[history.length - 1];

        // analyze() now uses only pre-computed incremental state — very fast
        const regime = detector.analyze(targetDigit);

        if (!regime.valid) return;

        if (!regime.signalActive) {
            const now = Date.now();
            if (now - this.lastTickLogTime2[asset] >= 60000) {
                logStatus(
                    `[${asset}] Signal blocked | HMM=${regime.hmmStateName} | Safety=${regime.safetyScore} | ` +
                    `P(NR)=${(regime.posteriorNR * 100).toFixed(1)}% | BOCPD=${regime.bocpdIsNonRep ? '✓' : '✗'}`
                );
                this.lastTickLogTime2[asset] = now;
            }
            return;
        }

        const safetyScore = regime.safetyScore;
        const componentScores = regime.componentScores;

        logStatus(
            `✅ [${asset}] SIGNAL ACTIVE | Safety=${safetyScore} | ` +
            `HMM=${regime.hmmStateName}(P=${regime.posteriorNR.toFixed(3)}) | ` +
            `BOCPD=RL${regime.bocpdModeRL}t(${(regime.bocpdPNonRep * 100).toFixed(1)}%) | ` +
            `Scores: B=${componentScores.bocpdScore.toFixed(1)}/H=${componentScores.hmmScore.toFixed(1)}/E=${componentScores.ewmaScore.toFixed(1)}`
        );

        // Execute trade
        this.placeTrade(asset, targetDigit, safetyScore, regime);
    }

    // ========================================================================
    // TRADE EXECUTION
    // ========================================================================
    placeTrade(asset, digit, safetyScore, regime) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.lastTradeDigit[asset] = digit;
        this.asset_safety_score[asset] = (regime.posteriorNR * 100).toFixed(1);
        this.lastTradeTime[asset] = Date.now();
        this.ticksSinceLastTrade[asset] = 0;

        console.log(`\n🎯 TRADE SIGNAL — ${asset}`);
        console.log(`   Digit: ${digit}`);
        console.log(`   Safety Score: ${safetyScore}/100`);
        console.log(`   Ensemble: HMM=${regime.hmmStateName} | BOCPD RL=${regime.bocpdModeRL}t | ACF[1]=${regime.acf[0].toFixed(3)}`);
        console.log(`   Confidence: P(NR)=${(regime.posteriorNR * 100).toFixed(1)}%`);
        console.log(`   Persistence: ${regime.hmmPersistence} ticks`);
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
            🎯 <b>TRADE OPENED — ENSEMBLE V2 Multi</b>

            📊 Asset: ${asset}
            🔢 Target Digit: ${digit}
            📈 Last 10: ${this.histories[asset].slice(-10).join(',')}

            🔬 <b>ENSEMBLE METRICS</b>
            ├ Safety: ${safetyScore}/100
            ├ HMM: ${regime.hmmStateName} (P=${(regime.posteriorNR * 100).toFixed(1)}%)
            ├ BOCPD: ${regime.bocpdModeRL}t (P(NR)=${(regime.bocpdPNonRep * 100).toFixed(1)}%)
            ├ EWMA: ${regime.ewmaTrend.toFixed(2)}([${regime.ewmaValues.map(v => v.toFixed(1)).join(',')}]%)
            ├ ACF[1]: ${regime.acf[0].toFixed(3)}
            ├ CUSUM Up: ${regime.cusumUp.toFixed(2)}
            └ Persistence: ${regime.hmmPersistence}t

            💰 Stake: $${this.stake.toFixed(2)}
            📊 Losses: ${this.consecutiveLosses}
        `.trim());
    }

    // ========================================================================
    // TRADE RESULT HANDLING — REMOVED REDUNDANT analyze() CALL
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

        // Use the per-asset detector's current state for feedback
        // NO redundant analyze() call — just use the detector's existing state
        const detector = this.detectors[asset];
        if (detector) {
            // Lightweight feedback: adjust weights based on outcome
            // Use the last known regime state (already computed during signal scan)
            const lastRegime = { valid: true }; // Minimal stub — the weights adjustment doesn't need full regime
            detector.applyTradeFeedback(won, lastRegime);

            // Reset CUSUM for this digit on alarm to allow recovery
            if (!won && detector.cusum.upAlarm(this.lastTradeDigit[asset])) {
                detector.resetCUSUM(this.lastTradeDigit[asset]);
            }
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

            if (this.consecutiveLosses === 1) {
                this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            } else {
                this.stake = this.config.baseStake *
                    Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            }
            this.stake = Math.round(this.stake * 100) / 100;
        }

        this.sendTelegram(`
            ${won ? '✅ <b>ENSEMBLE BOT WIN!</b>' : '❌ <b>ENSEMBLE BOT LOSS!</b>'}

            📊 Symbol: ${asset}
            🎯 Target: ${this.lastTradeDigit[asset]}
            🔢 Exit: ${exitDigit}
            📈 Last 10: ${this.histories[asset].slice(-10).join(',')}
            🛡️ Safety: ${this.asset_safety_score[asset]}/100

            💰 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            💵 Balance: $${this.netProfit.toFixed(2)}
            📊 Record: ${this.totalWins}W/${this.totalTrades - this.totalWins}L | Losses: ${this.consecutiveLosses}${this.consecutiveLosses > 1 ? ` (x${this.consecutiveLosses})` : ''}
            📊 WIN RATE: ${((this.totalWins / this.totalTrades) * 100).toFixed(1)}%
            💲 Next Stake: $${this.stake.toFixed(2)}
        `.trim());

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
                    console.log("Past 5:00 PM GMT+1 after win, disconnecting.");
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
console.log('  Advanced Regime Detection v3.1 (FIXED)');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new RomanianGhostUltimate();
