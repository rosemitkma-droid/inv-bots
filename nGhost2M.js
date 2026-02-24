// ============================================================================
// ROMANIAN GHOST BLACK FIBONACCI 9.2 ULTIMATE — NOVEMBER 2025
// INTEGRATED WITH ADVANCED REGIME DETECTION v3.0
// BOCPD + Binary HMM + EWMA Stack + ACF + Structural Break + CUSUM Ensemble
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "DMylfkyce6VyZt7";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'nGhost2M-state.json');

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}
function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }

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
//  COMPONENT 1: BOCPD (Bayesian Online Changepoint Detection)
// ══════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard = config.bocpd_hazard;
        this.alpha0 = config.bocpd_prior_alpha;
        this.beta0 = config.bocpd_prior_beta;
        this.threshold = config.bocpd_nonrep_confidence;
        this.minRun = config.bocpd_min_run_for_signal;

        this.logR = [0];
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];
        this.t = 0;
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }

    update(obs) {
        const ones = obs ? 1 : 0;
        const zeros = 1 - ones;
        const T = this.logR.length;

        const newAlphas = [];
        const newBetas = [];
        const newLogR = new Array(T + 1).fill(-Infinity);

        for (let r = 0; r < T; r++) {
            const a = this.alphas[r] + ones;
            const b = this.betas[r] + zeros;
            const betaBinom = this.betaLogPMF(ones, a, b);
            newAlphas.push(a);
            newBetas.push(b);
            newLogR[r + 1] = this.logR[r] + (Math.log(1 - this.hazard) + betaBinom);
        }

        const a = this.alpha0 + ones;
        const b = this.beta0 + zeros;
        const betaBinom = this.betaLogPMF(ones, a, b);
        newLogR[0] = Math.log(this.hazard) + betaBinom;
        newAlphas.unshift(a);
        newBetas.unshift(b);

        const logRmax = Math.max(...newLogR.slice(0, -1));
        if (logRmax > -20) {
            const mask = newLogR.map((lr, i) => i === 0 || lr > logRmax - 40);
            this.logR = newLogR.filter((_, i) => mask[i]);
            this.alphas = newAlphas.filter((_, i) => mask[i]);
            this.betas = newBetas.filter((_, i) => mask[i]);
        } else {
            this.logR = newLogR;
            this.alphas = newAlphas;
            this.betas = newBetas;
        }

        const logRden = logSumExp(this.logR);
        this.logR = this.logR.map(lr => Math.exp(lr - logRden));

        this.pNonRep = 1 - this.logR[0];
        this.expectedRunLength = this.logR.reduce((s, p, i) => s + i * p, 0);
        const mode = this.logR.indexOf(Math.max(...this.logR));
        this.modeRL = mode;
        this.thetaEstimate = (this.alpha0 + ones) / (this.alpha0 + this.beta0 + 1);
        this.pChangepoint = this.logR[0];
        this.t++;

        return { pNonRep: this.pNonRep, expectedRL: this.expectedRunLength, modeRL: mode, thetaEstimate: this.thetaEstimate, pChangepoint: this.pChangepoint };
    }

    betaLogPMF(k, a, b) {
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
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 2: BINARY HMM
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
        for (let t = 1; t < digitSeq.length; t++) obs[t - 1] = digitSeq[t] === digitSeq[t - 1] ? 1 : 0;
        return obs;
    }

    baumWelch(obs, maxIter = 30, tol = 1e-6) {
        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };

        let pi = [...this.pi], A = this.A.map(r => [...r]), B = this.B.map(r => [...r]), prevLogL = -Infinity;

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
        if (discrimination < this.MIN_DISCRIM) return { accepted: false, discrimination, repeatNR: B[0][1], repeatREP: B[1][1], reason: `discrimination ${(discrimination * 100).toFixed(1)}% < ${(this.MIN_DISCRIM * 100).toFixed(0)}%` };

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
        return { stateSeq: seq, currentState: cur, persistence, transitions };
    }

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

    const chi2cdf = lrtStat <= 0 ? 0 : Math.min(0.9999, 1 - Math.exp(-0.5 * Math.pow(Math.max(0, lrtStat), 1) * 0.5));
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
        const obs = isRepeat ? 1 : 0;
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
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN ENSEMBLE REGIME DETECTOR
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
            if (fitResult?.accepted) {
                logHMM(`📐 Binary HMM fitted | A(NR→NR)=${(this.hmm.A[0][0] * 100).toFixed(1)}% | B(rep|NR)=${(fitResult.repeatNR * 100).toFixed(1)}% Discrim:${(fitResult.discrimination * 100).toFixed(1)}% ✅`);
            }
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

        // ENSEMBLE SCORING (0–100)
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
            valid: true, hmmState: vit.currentState, hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence, hmmTransitions: vit.transitions, posteriorNR, posteriorRep,
            hmmA: this.hmm.A, hmmB_repeatNR: this.hmm.repeatEmission(0), hmmB_repeatREP: this.hmm.repeatEmission(1),
            hmmDiscrim: this.hmm.lastFitDiscrim, bocpdPNonRep: bocpd.pNonRep, bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL, bocpdTheta: bocpd.thetaEstimate, bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(), ewmaValues, ewmaTrend, acf, structBreak: breakResult,
            cusumUpAlarm, cusumDownConfirm, cusumUp: this.cusum.upC[targetDigit], cusumDown: this.cusum.downC[targetDigit],
            cusumGlobalUp: this.cusum.globalUp, rawRepeatProb, recentRate, componentScores: { bocpdScore, hmmScore, ewmaScore, acfScore, breakScore, cusumScore },
            safetyScore, signalActive,
        };
    }

    applyTradeFeedback(won, regime) {
        if (!regime || !regime.valid) return;
        const decay = 0.85, restore = 1.02;
        if (!won) for (const key of Object.keys(this.weights)) this.weights[key] = Math.max(0.5, this.weights[key] * decay);
        else for (const key of Object.keys(this.weights)) this.weights[key] = Math.min(1.0, this.weights[key] * restore);
    }

    resetCUSUM(digit) { this.cusum.resetDigit(digit); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════
class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                stake: bot.stake,
                consecutiveLosses: bot.consecutiveLosses,
                totalTrades: bot.totalTrades,
                totalWins: bot.totalWins,
                x2: bot.x2, x3: bot.x3, x4: bot.x4, x5: bot.x5,
                netProfit: bot.netProfit,
                lastTradeDigit: bot.lastTradeDigit,
                lastTradeTime: bot.lastTradeTime,
                ticksSinceLastTrade: bot.ticksSinceLastTrade,
                accountBalance: bot.accountBalance,
                startingBalance: bot.startingBalance,
                sessionStartTime: bot.sessionStartTime
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            console.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => { StatePersistence.saveState(bot); }, 5000);
        console.log('🔄 Auto-save started (every 5 seconds)');
    }
}

class RomanianGhostUltimate {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
            assets: [
                'R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR',
            ],  // Multi-asset support
            requiredHistoryLength: 5000,
            minHistoryForTrading: 5000,

            // ====== ENSEMBLE REGIME DETECTION SETTINGS ======
            // BOCPD parameters
            bocpd_hazard: 1 / 150,
            bocpd_prior_alpha: 1,
            bocpd_prior_beta: 9,
            bocpd_nonrep_confidence: 0.82,
            bocpd_min_run_for_signal: 15,
            
            // HMM parameters
            hmm_min_discrimination: 0.10,
            hmm_refit_every: 50,
            hmm_nonrep_confidence: 0.88,
            min_regime_persistence: 8,
            
            // EWMA parameters
            ewma_trend_threshold: 2.0,
            
            // ACF parameters
            acf_lag1_threshold: 0.15,
            
            // Structural break parameters
            structural_break_threshold: 0.15,
            
            // CUSUM parameters
            cusum_slack: 0.005,
            cusum_up_threshold: 4.5,
            cusum_down_threshold: -4.5,
            
            // General regime analysis
            analysis_window: 5000,
            min_ticks_for_analysis: 50,
            repeat_threshold: 8,
            repeat_confidence: 60,

            // Money management
            baseStake: 2.20,
            firstLossMultiplier: 11.3,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 6,
            takeProfit: 10000,
            stopLoss: -500,

            // Time filters (avoid volatile periods)
            avoidMinutesAroundHour: 5,    // Avoid first/last 5 min of hour
            tradingHoursUTC: { start: 0, end: 24 },  // 24/7 for synthetics
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

        this.assetHMMs = new Map(); // symbol → AdvancedRegimeDetector (shared instance)
        this.detector = null; // Will be initialized after first subscription
        this.tickCount = 0;
        this.assetTickers = {}; // Track per-asset ticker history for detector.tick()
        this.config.assets.forEach(a => this.assetTickers[a] = []);

        // Performance tracking (for adaptive thresholds)
        this.recentTrades = [];  // Last 50 trades for analysis
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
        // this.checkTimeForDisconnectReconnect();
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
            // Enhanced state persistence with regime tracking
            const stateData = {
                savedAt: Date.now(),
                stake: this.stake,
                consecutiveLosses: this.consecutiveLosses,
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                x2: this.x2, x3: this.x3, x4: this.x4, x5: this.x5,
                netProfit: this.netProfit,
                recentTrades: this.recentTrades,

                // Add regime tracking for analysis
                lastTradeDigit: this.lastTradeDigit,
                lastTradeTime: this.lastTradeTime,
                ticksSinceLastTrade: this.ticksSinceLastTrade,

                // Extended session stats
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

            // Only restore if state is recent (within 30 minutes)
            if (Date.now() - data.savedAt > 30 * 60 * 1000) return;

            // Restore basic stats
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

            // Restore regime tracking if available
            if (data.lastTradeDigit) {
                this.lastTradeDigit = data.lastTradeDigit;
            }
            if (data.lastTradeTime) {
                this.lastTradeTime = data.lastTradeTime;
            }
            if (data.ticksSinceLastTrade) {
                this.ticksSinceLastTrade = data.ticksSinceLastTrade;
            }

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
            ⏰ <b>HOURLY — GHOST Bot v2 Milti2</b>

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
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }

    // Extract last digit based on asset type (CORRECTED - handles fractional digits properly)
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

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];
        this.histories[asset] = prices.map(p => this.getLastDigit(p, asset));
        this.historyLoaded[asset] = true;

        // Initialize shared AdvancedRegimeDetector on first asset load
        if (!this.detector) {
            this.detector = new AdvancedRegimeDetector(this.config);
            logBocpd('🚀 Shared AdvancedRegimeDetector initialized with 6-component ensemble');
        }

        console.log(`📊 Loaded ${this.histories[asset].length} ticks for ${asset} | Ensemble detector active`);
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

        // Feed detector with previous→current transition (for BOCPD, HMM, EWMA, CUSUM updates)
        if (this.detector && this.histories[asset].length >= 2) {
            const prevDigit = this.histories[asset][this.histories[asset].length - 2];
            this.detector.tick(prevDigit, lastDigit);
        }

        // Increment cooldown counter
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
    // MAIN SIGNAL SCANNER (ADVANCED 6-COMPONENT ENSEMBLE)
    // ========================================================================
    scanForSignal(asset) {
        if (this.tradeInProgress) return;

        const history = this.histories[asset];
        if (history.length < this.config.min_ticks_for_analysis) return;
        if (!this.detector) return;

        // Get current target digit
        const targetDigit = history[history.length - 1];

        // Run full ensemble analysis
        const regime = this.detector.analyze(history, targetDigit);

        if (!regime.valid) return;
        if (!regime.signalActive) {
            // Log blockers for debugging (sparse)
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

        // Extract ensemble data
        const safetyScore = regime.safetyScore;
        const componentScores = regime.componentScores;

        // LOG SIGNAL CONFIRMATION
        const now = Date.now();
        logStatus(
            `✅ [${asset}] SIGNAL ACTIVE | Safety=${safetyScore} | ` +
            `HMM=${regime.hmmStateName}(P=${regime.posteriorNR.toFixed(3)}) | ` +
            `BOCPD=RL${regime.bocpdModeRL}t(${(regime.bocpdPNonRep * 100).toFixed(1)}%) | ` +
            `Scores: B=${componentScores.bocpdScore.toFixed(1)}/H=${componentScores.hmmScore.toFixed(1)}/E=${componentScores.ewmaScore.toFixed(1)}`
        );

        // Gating conditions (hard gates from ensemble)
        if (regime.hmmState !== 0) {
            logStatus(`[${asset}] Blocked - Not in NON-REP state`);
            return;
        }
        if (safetyScore < this.config.repeat_confidence) {
            logStatus(`[${asset}] Blocked - Safety score too low (${safetyScore} < ${this.config.repeat_confidence})`);
            return;
        }

        // Execute trade with ensemble regime data
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
            ├ EWMA: ${regime.ewmaTrend.toFixed(2)}([${regime.ewmaValues.map(v=>v.toFixed(1)).join(',')}]%)
            ├ ACF[1]: ${regime.acf[0].toFixed(3)}
            ├ CUSUM Up: ${regime.cusumUp.toFixed(2)}
            └ Persistence: ${regime.hmmPersistence}t

            💰 Stake: $${this.stake.toFixed(2)}
            📊 Losses: ${this.consecutiveLosses}
        `.trim());
    }

    // ========================================================================
    // TRADE RESULT HANDLING (ENHANCED WITH ADVANCED ENSEMBLE ANALYSIS)
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

        // Track for adaptive thresholds
        this.recentTrades.push({ won, profit, time: Date.now() });
        if (this.recentTrades.length > this.maxRecentTrades) {
            this.recentTrades.shift();
        }

        // Get ensemble regime data if available
        const history = this.histories[asset];
        let regime = null;
        if (this.detector && history.length >= this.config.min_ticks_for_analysis) {
            regime = this.detector.analyze(history, exitDigit);
            if (regime.valid) {
                // Update adaptive weights based on trade outcome
                this.detector.applyTradeFeedback(won, regime);
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

            // Money management
            if (this.consecutiveLosses === 1) {
                this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            } else {
                this.stake = this.config.baseStake *
                    Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            }
            this.stake = Math.round(this.stake * 100) / 100;
        }

        // Enhanced Telegram Alert with full ensemble data
        let telegramContent = `
            ${won ? '✅ <b>ENSEMBLE BOT WIN!</b>' : '❌ <b>ENSEMBLE BOT LOSS!</b>'}

            📊 Symbol: ${asset}
            🎯 Target: ${this.lastTradeDigit[asset]}
            🔢 Exit: ${exitDigit}
            📈 Last 10: ${this.histories[asset].slice(-10).join(',')}
            🛡️ Safety: ${this.asset_safety_score[asset]}/100
            
            ${regime && regime.valid ? `
            🔬 <b>ENSEMBLE STATE</b>
            ├ BOCPD: ${regime.bocpdModeRL}(${(regime.bocpdPNonRep * 100).toFixed(1)}%)
            ├ HMM: ${regime.hmmStateName} (P=${(regime.posteriorNR * 100).toFixed(1)}%)
            ├ EWMA: ${regime.ewmaTrend.toFixed(2)}([${regime.ewmaValues.map(v=>v.toFixed(1)).join(',')}]%)
            ├ ACF[1]: ${regime.acf[0].toFixed(3)}
            ├ CUSUM: ${regime.cusumUp.toFixed(2)}
            └ Persist: ${regime.hmmPersistence}t
            ` : ''}
            
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
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 8am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
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
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new RomanianGhostUltimate();
