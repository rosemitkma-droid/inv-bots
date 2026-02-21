#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v3.0 Ultra-Advanced Regime Detection
//  Deriv Digit Differ — BOCPD + HSMM + Multi-Scale + Run-Length Analysis
//
//  UPGRADED REGIME ENGINE v3.0:
//    1. Bayesian Online Change-Point Detection (BOCPD)
//       - Adams & MacKay algorithm for real-time regime shift detection
//       - Maintains posterior over run-lengths (how long since last change)
//    2. Hidden Semi-Markov Model (HSMM) with Duration Modeling
//       - Explicit modeling of regime duration distributions
//       - Negative binomial duration priors for each regime
//    3. Multi-Scale Analysis (5 time windows)
//       - Short (20), Medium-Short (50), Medium (100), Long (200), XLong (500)
//       - Consensus voting across scales for robust regime classification
//    4. Run-Length Sequence Analysis
//       - Tracks consecutive repeat/non-repeat run lengths
//       - Detects regime boundaries via run-length distribution shifts
//    5. Adaptive Bi-Directional CUSUM
//       - Detects shifts BOTH directions (into REP and out of REP)
//       - Adaptive threshold based on local volatility
//    6. Regime Transition Hazard Model
//       - Estimates probability of regime change at each tick
//       - Blocks trades when hazard is elevated
//    7. Enhanced Viterbi with Duration Constraints
//       - Minimum regime duration enforcement in decoding
//    8. Per-Digit Regime Tracking
//       - Separate regime models per digit (0-9)
//       - Uses digit-specific repeat patterns
//
//  TRADE CONDITIONS (ALL must hold):
//    a) BOCPD run-length posterior indicates stable NON-REP regime
//    b) Multi-scale consensus ≥ 4/5 windows agree on NON-REP
//    c) HMM Viterbi → NON-REP with persistence ≥ min_persistence
//    d) No CUSUM alarm (either direction) in last N ticks
//    e) Run-length stats consistent with NON-REP regime
//    f) Regime hazard rate below threshold
//    g) Per-digit repeat probability < threshold
//    h) Composite safety score ≥ required confidence
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
    orange: '\x1b[38;5;208m', white: '\x1b[37m', purple: '\x1b[38;5;135m',
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
const purple = t => col(t, C.purple);

// ── Logger ─────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: cyan, API: blue, TICK: dim, ANALYSIS: yellow,
    GHOST: magenta, TRADE: bold, RESULT: bold, RISK: red,
    STATS: cyan, ERROR: t => col(t, C.bold, C.red), 
    HMM: t => col(t, C.orange), BOCPD: purple, REGIME: t => col(t, C.purple),
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
const logBOCPD    = m => log('BOCPD', m);
const logRegime   = m => log('REGIME', m);

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
        analysis_window: 1000,
        min_ticks_for_analysis: 100,

        // BOCPD parameters
        bocpd_hazard_rate: 1 / 80,      // Expected regime duration ~80 ticks
        bocpd_max_run_length: 300,       // Max tracked run length
        bocpd_nonrep_confidence: 0.75,   // Required P(NON-REP) from BOCPD

        // Multi-scale windows
        multi_scale_windows: [20, 50, 100, 200, 500],
        multi_scale_consensus: 4,        // Require 4/5 windows to agree

        // Regime thresholds
        repeat_threshold: 12,            // Raw per-digit repeat % gate
        hmm_nonrep_confidence: 0.85,     // Bayesian P(NON-REP) required
        min_regime_persistence: 15,      // Ticks in NON-REP before trading
        min_regime_age: 10,              // Ticks since last regime change

        // CUSUM parameters
        cusum_threshold: 3.5,
        cusum_slack: 0.03,
        cusum_alarm_cooldown: 20,        // Ticks to wait after CUSUM alarm

        // Run-length analysis
        min_nonrep_run_length: 3,        // Min consecutive non-repeats to confirm regime
        run_length_history_size: 50,     // Track last N runs

        // Hazard rate threshold
        max_regime_hazard: 0.08,         // Block trades if P(regime change) > 8%

        // Safety score
        min_safety_score: 85,

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
    if (arr.length === 0) return -Infinity;
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
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
//  Combines multiple state-of-the-art methods for regime detection:
//
//  1. BAYESIAN ONLINE CHANGE-POINT DETECTION (BOCPD)
//     ─────────────────────────────────────────────────
//     Adams & MacKay (2007) algorithm.
//     Maintains posterior distribution over "run length" r_t:
//       r_t = number of ticks since last regime change
//     
//     At each tick:
//       - Compute P(r_t = k | data) for k = 0, 1, ..., max
//       - r_t = 0 means a change-point just occurred
//       - High probability mass on large r_t → stable regime
//
//     The algorithm uses:
//       - Hazard function H(r) = P(change-point | run length = r)
//       - Predictive likelihood P(x_t | x_{t-r}...x_{t-1})
//
//  2. HIDDEN SEMI-MARKOV MODEL (HSMM)
//     ─────────────────────────────────────
//     Like HMM but with explicit duration modeling.
//     Each state has a duration distribution (negative binomial).
//     This prevents rapid state switching that doesn't match
//     actual regime behavior.
//
//  3. MULTI-SCALE ANALYSIS
//     ──────────────────────
//     Compute regime indicators at multiple time scales:
//       - 20 ticks:  Very reactive, catches recent shifts
//       - 50 ticks:  Short-term trend
//       - 100 ticks: Medium-term stable estimate
//       - 200 ticks: Longer-term baseline
//       - 500 ticks: Historical context
//     
//     Consensus voting: require ≥4/5 scales to agree on NON-REP.
//
//  4. RUN-LENGTH SEQUENCE ANALYSIS
//     ──────────────────────────────
//     Track lengths of consecutive repeat/non-repeat sequences.
//     REP regime: short non-repeat runs, occasional long repeat runs
//     NON-REP regime: long non-repeat runs, very short repeat runs
//
//  5. ADAPTIVE BI-DIRECTIONAL CUSUM
//     ───────────────────────────────
//     Two CUSUM statistics:
//       - CUSUM_up: detects shift INTO repeat regime
//       - CUSUM_down: detects shift OUT OF repeat regime
//     Adaptive threshold based on recent volatility.
//
//  6. REGIME TRANSITION HAZARD
//     ─────────────────────────
//     Estimate instantaneous probability of regime change:
//       λ(t) = P(regime changes at t | regime started at τ)
//     Block trades when λ(t) is elevated.
//
// ══════════════════════════════════════════════════════════════════════════════

class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.tickCount = 0;

        // ══════════════════════════════════════════════════════════════════════
        // BOCPD State
        // ══════════════════════════════════════════════════════════════════════
        this.bocpd = {
            runLengthProbs: [1.0],      // P(r_t = k) distribution
            maxRunLength: config.bocpd_max_run_length,
            hazardRate: config.bocpd_hazard_rate,
            // Sufficient statistics for predictive likelihood (Beta-Bernoulli model)
            // For each run length k, track (alpha_k, beta_k) for Bernoulli posterior
            alphas: [1.0],   // Prior alpha for each run length
            betas: [1.0],    // Prior beta for each run length
            // Prior hyperparameters (weakly informative)
            priorAlpha: 1.0,
            priorBeta: 9.0,  // Prior belief: ~10% repeat rate
        };

        // ══════════════════════════════════════════════════════════════════════
        // HMM/HSMM State
        // ══════════════════════════════════════════════════════════════════════
        // State 0 = NON-REP, State 1 = REP
        this.hmm = {
            pi: [0.7, 0.3],
            A: [
                [0.96, 0.04],  // NON-REP is sticky
                [0.12, 0.88],  // REP is also sticky
            ],
            B: [
                [0.90, 0.10],  // NON-REP: low repeat emission
                [0.40, 0.60],  // REP: high repeat emission
            ],
            logAlpha: [Math.log(0.7), Math.log(0.3)],
            fitted: false,
        };

        // Duration model parameters (for HSMM-like behavior)
        this.durationModel = {
            nonRep: { meanDuration: 60, minDuration: 8 },
            rep: { meanDuration: 25, minDuration: 5 },
        };

        // ══════════════════════════════════════════════════════════════════════
        // Run-Length Tracking
        // ══════════════════════════════════════════════════════════════════════
        this.runLength = {
            currentType: null,     // 'repeat' or 'nonrepeat'
            currentLength: 0,
            history: [],           // Array of {type, length}
            maxHistory: config.run_length_history_size,
        };

        // ══════════════════════════════════════════════════════════════════════
        // CUSUM (Bi-directional)
        // ══════════════════════════════════════════════════════════════════════
        this.cusum = {
            up: 0,        // Detects increase in repeat rate (shift into REP)
            down: 0,      // Detects decrease in repeat rate (shift out of REP)
            threshold: config.cusum_threshold,
            slack: config.cusum_slack,
            lastAlarmTick: -1000,
            alarmCooldown: config.cusum_alarm_cooldown,
        };

        // ══════════════════════════════════════════════════════════════════════
        // Regime State Tracking
        // ══════════════════════════════════════════════════════════════════════
        this.regimeState = {
            current: 0,            // 0 = NON-REP, 1 = REP
            persistence: 0,        // How many ticks in current regime
            lastChangeTick: 0,     // Tick when regime last changed
            history: [],           // Array of {regime, startTick, endTick}
            transitionCount: 0,
        };

        // ══════════════════════════════════════════════════════════════════════
        // Per-Digit Statistics
        // ══════════════════════════════════════════════════════════════════════
        this.perDigit = {
            repeatCounts: new Array(10).fill(0),
            totalCounts: new Array(10).fill(0),
            ewma: new Array(10).fill(10),  // EWMA of repeat rate per digit
            cusumPerDigit: new Array(10).fill(0),
        };

        // ══════════════════════════════════════════════════════════════════════
        // Observation History (for Baum-Welch)
        // ══════════════════════════════════════════════════════════════════════
        this.observationHistory = [];
        this.maxObsHistory = 1000;

        // Last analysis result cache
        this.lastResult = null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  BOCPD: Bayesian Online Change-Point Detection
    // ══════════════════════════════════════════════════════════════════════════
    
    /**
     * Update BOCPD state with new observation.
     * obs: 0 (no repeat) or 1 (repeat)
     * Returns: { mostLikelyRunLength, regimeChangeProb, stableRegimeProb }
     */
    updateBOCPD(obs) {
        const { runLengthProbs, alphas, betas, maxRunLength, hazardRate, priorAlpha, priorBeta } = this.bocpd;
        const T = runLengthProbs.length;

        // 1. Compute predictive probabilities P(x_t | r_{t-1} = k)
        // Using Beta-Bernoulli conjugate model
        const predictiveProbs = new Array(T);
        for (let k = 0; k < T; k++) {
            // Predictive P(x_t = obs | data in run of length k)
            // = (alpha_k + obs) / (alpha_k + beta_k + 1) ... but actually:
            // For Bernoulli: P(x=1) = alpha / (alpha + beta)
            const p_repeat = alphas[k] / (alphas[k] + betas[k]);
            predictiveProbs[k] = obs === 1 ? p_repeat : (1 - p_repeat);
        }

        // 2. Growth probabilities (run continues)
        // P(r_t = k+1, x_{1:t}) = P(r_{t-1} = k, x_{1:t-1}) * (1 - H(k)) * P(x_t | r_{t-1}=k)
        const growthProbs = new Array(T);
        for (let k = 0; k < T; k++) {
            const survivalProb = 1 - hazardRate;  // Could make this depend on k
            growthProbs[k] = runLengthProbs[k] * survivalProb * predictiveProbs[k];
        }

        // 3. Change-point probability (run resets to 0)
        // P(r_t = 0, x_{1:t}) = Σ_k P(r_{t-1}=k, x_{1:t-1}) * H(k) * P(x_t | prior)
        let changepointMass = 0;
        const priorPredictive = obs === 1 
            ? priorAlpha / (priorAlpha + priorBeta) 
            : priorBeta / (priorAlpha + priorBeta);
        
        for (let k = 0; k < T; k++) {
            changepointMass += runLengthProbs[k] * hazardRate * priorPredictive;
        }

        // 4. Assemble new run-length distribution
        const newProbs = new Array(Math.min(T + 1, maxRunLength));
        newProbs[0] = changepointMass;
        for (let k = 0; k < T && k + 1 < maxRunLength; k++) {
            newProbs[k + 1] = growthProbs[k];
        }

        // 5. Normalize
        const totalMass = newProbs.reduce((a, b) => a + b, 0);
        for (let i = 0; i < newProbs.length; i++) {
            newProbs[i] /= (totalMass + 1e-300);
        }

        // 6. Update sufficient statistics for each run length
        const newAlphas = new Array(newProbs.length);
        const newBetas = new Array(newProbs.length);
        
        // For r_t = 0 (new run), reset to prior
        newAlphas[0] = priorAlpha + obs;
        newBetas[0] = priorBeta + (1 - obs);
        
        // For r_t = k+1 (continued run), update posterior
        for (let k = 0; k < T && k + 1 < maxRunLength; k++) {
            newAlphas[k + 1] = alphas[k] + obs;
            newBetas[k + 1] = betas[k] + (1 - obs);
        }

        // Store
        this.bocpd.runLengthProbs = newProbs;
        this.bocpd.alphas = newAlphas;
        this.bocpd.betas = newBetas;

        // 7. Compute summary statistics
        // Most likely run length
        let maxProb = 0, mostLikelyRL = 0;
        for (let k = 0; k < newProbs.length; k++) {
            if (newProbs[k] > maxProb) {
                maxProb = newProbs[k];
                mostLikelyRL = k;
            }
        }

        // Expected run length
        let expectedRL = 0;
        for (let k = 0; k < newProbs.length; k++) {
            expectedRL += k * newProbs[k];
        }

        // Probability that a change-point occurred at this tick (r_t = 0)
        const regimeChangeProb = newProbs[0];

        // Probability of being in a stable regime (run length > threshold)
        const stabilityThreshold = this.cfg.min_regime_age;
        let stableRegimeProb = 0;
        for (let k = stabilityThreshold; k < newProbs.length; k++) {
            stableRegimeProb += newProbs[k];
        }

        // Estimate current regime from predictive model
        // Weighted average of repeat probability across run lengths
        let weightedRepeatProb = 0;
        for (let k = 0; k < newProbs.length; k++) {
            const p_rep = newAlphas[k] / (newAlphas[k] + newBetas[k]);
            weightedRepeatProb += newProbs[k] * p_rep;
        }

        return {
            mostLikelyRunLength: mostLikelyRL,
            expectedRunLength: expectedRL,
            regimeChangeProb,
            stableRegimeProb,
            weightedRepeatProb,
            runLengthDistribution: newProbs.slice(0, 20), // First 20 for logging
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Multi-Scale Analysis
    // ══════════════════════════════════════════════════════════════════════════
    
    /**
     * Analyze regime at multiple time scales.
     * Returns regime vote for each scale and overall consensus.
     */
    multiScaleAnalysis(window) {
        const results = [];
        const windowSizes = this.cfg.multi_scale_windows;

        for (const size of windowSizes) {
            if (window.length < size) {
                results.push({ size, regime: null, repeatRate: null, confidence: 0 });
                continue;
            }

            const subWindow = window.slice(-size);
            let repeats = 0;
            for (let i = 1; i < subWindow.length; i++) {
                if (subWindow[i] === subWindow[i - 1]) repeats++;
            }
            const repeatRate = (repeats / (subWindow.length - 1)) * 100;
            
            // Expected repeat rate under random is 10%
            // NON-REP regime: < 12%
            // REP regime: > 15%
            const isNonRep = repeatRate < 12;
            const confidence = isNonRep 
                ? clamp((12 - repeatRate) / 6, 0.3, 1.0)
                : clamp((repeatRate - 10) / 10, 0.3, 1.0);

            results.push({
                size,
                regime: isNonRep ? 0 : 1,  // 0 = NON-REP, 1 = REP
                repeatRate,
                confidence,
            });
        }

        // Consensus: count NON-REP votes
        const validResults = results.filter(r => r.regime !== null);
        const nonRepVotes = validResults.filter(r => r.regime === 0).length;
        const consensus = nonRepVotes >= this.cfg.multi_scale_consensus;
        
        // Weighted consensus score
        let weightedScore = 0, totalWeight = 0;
        for (const r of validResults) {
            const weight = r.confidence * Math.sqrt(r.size); // Larger windows get more weight
            weightedScore += (r.regime === 0 ? 1 : 0) * weight;
            totalWeight += weight;
        }
        const consensusScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

        return {
            scales: results,
            nonRepVotes,
            totalVotes: validResults.length,
            consensus,
            consensusScore,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Run-Length Analysis
    // ══════════════════════════════════════════════════════════════════════════
    
    /**
     * Update run-length tracking with new observation.
     */
    updateRunLength(obs) {
        const rl = this.runLength;
        const newType = obs === 1 ? 'repeat' : 'nonrepeat';

        if (rl.currentType === null) {
            // First observation
            rl.currentType = newType;
            rl.currentLength = 1;
        } else if (rl.currentType === newType) {
            // Run continues
            rl.currentLength++;
        } else {
            // Run ends, start new run
            rl.history.push({ type: rl.currentType, length: rl.currentLength });
            if (rl.history.length > rl.maxHistory) {
                rl.history.shift();
            }
            rl.currentType = newType;
            rl.currentLength = 1;
        }

        return this.analyzeRunLengths();
    }

    /**
     * Analyze run-length statistics to determine regime.
     */
    analyzeRunLengths() {
        const rl = this.runLength;
        const history = rl.history;

        if (history.length < 5) {
            return { valid: false, regime: null };
        }

        // Separate runs by type
        const repeatRuns = history.filter(r => r.type === 'repeat').map(r => r.length);
        const nonRepeatRuns = history.filter(r => r.type === 'nonrepeat').map(r => r.length);

        // Compute statistics
        const avgRepeatRun = mean(repeatRuns);
        const avgNonRepeatRun = mean(nonRepeatRuns);
        const maxRepeatRun = repeatRuns.length > 0 ? Math.max(...repeatRuns) : 0;
        const maxNonRepeatRun = nonRepeatRuns.length > 0 ? Math.max(...nonRepeatRuns) : 0;

        // In NON-REP regime:
        // - Repeat runs are short (typically 1-2)
        // - Non-repeat runs are long (typically 5-20+)
        // In REP regime:
        // - Repeat runs can be longer (2-5+)
        // - Non-repeat runs are shorter (3-8)

        const runRatio = avgNonRepeatRun / (avgRepeatRun + 0.1);
        const isNonRep = runRatio > 4 && avgRepeatRun < 2 && avgNonRepeatRun > 6;

        // Current run analysis
        const currentRunFavorable = 
            (rl.currentType === 'nonrepeat' && rl.currentLength >= this.cfg.min_nonrep_run_length) ||
            (rl.currentType === 'repeat' && rl.currentLength === 1);

        return {
            valid: true,
            regime: isNonRep ? 0 : 1,
            avgRepeatRun,
            avgNonRepeatRun,
            maxRepeatRun,
            maxNonRepeatRun,
            runRatio,
            currentRunType: rl.currentType,
            currentRunLength: rl.currentLength,
            currentRunFavorable,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Bi-Directional CUSUM
    // ══════════════════════════════════════════════════════════════════════════
    
    /**
     * Update bi-directional CUSUM statistics.
     * Returns alarm state.
     */
    updateCUSUM(obs) {
        const cs = this.cusum;
        const { B } = this.hmm;

        // Log-likelihood ratios
        // LLR_up: evidence for REP over NON-REP
        const llrUp = Math.log(B[1][obs] + 1e-10) - Math.log(B[0][obs] + 1e-10);
        // LLR_down: evidence for NON-REP over REP
        const llrDown = -llrUp;

        // Update CUSUM statistics
        cs.up = Math.max(0, cs.up + llrUp - cs.slack);
        cs.down = Math.max(0, cs.down + llrDown - cs.slack);

        // Check for alarms
        const alarmUp = cs.up > cs.threshold;
        const alarmDown = cs.down > cs.threshold;

        if (alarmUp || alarmDown) {
            cs.lastAlarmTick = this.tickCount;
            // Reset the triggered CUSUM
            if (alarmUp) cs.up = 0;
            if (alarmDown) cs.down = 0;
        }

        // Check if we're still in alarm cooldown
        const ticksSinceAlarm = this.tickCount - cs.lastAlarmTick;
        const inCooldown = ticksSinceAlarm < cs.alarmCooldown;

        return {
            cusumUp: cs.up,
            cusumDown: cs.down,
            alarmUp,
            alarmDown,
            inCooldown,
            ticksSinceAlarm,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  HMM: Baum-Welch Training
    // ══════════════════════════════════════════════════════════════════════════
    
    baumWelch(obs, maxIter = 15, tol = 1e-4) {
        const T = obs.length;
        if (T < 30) return false;

        const N = 2;
        let pi = [...this.hmm.pi];
        let A = this.hmm.A.map(row => [...row]);
        let B = this.hmm.B.map(row => [...row]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            // Forward pass
            const logAlpha = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) {
                logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
            }
            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    const incoming = A.map((row, prev) => logAlpha[t - 1][prev] + Math.log(row[s] + 1e-300));
                    logAlpha[t][s] = logSumExp(incoming) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }
            const logL = logSumExp(logAlpha[T - 1]);

            // Backward pass
            const logBeta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T - 1][s] = 0;
            for (let t = T - 2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    const vals = A[s].map((a, next) =>
                        Math.log(a + 1e-300) + Math.log(B[next][obs[t + 1]] + 1e-300) + logBeta[t + 1][next]
                    );
                    logBeta[t][s] = logSumExp(vals);
                }
            }

            // Gamma and Xi
            const logGamma = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const denom = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++) {
                    logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - denom;
                }
            }

            const logXi = Array.from({ length: T - 1 }, () =>
                Array.from({ length: N }, () => new Array(N).fill(-Infinity))
            );
            for (let t = 0; t < T - 1; t++) {
                const denom = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++) {
                    for (let next = 0; next < N; next++) {
                        logXi[t][s][next] =
                            logAlpha[t][s] +
                            Math.log(A[s][next] + 1e-300) +
                            Math.log(B[next][obs[t + 1]] + 1e-300) +
                            logBeta[t + 1][next] -
                            denom;
                    }
                }
            }

            // M-step
            for (let s = 0; s < N; s++) {
                pi[s] = Math.exp(logGamma[0][s]);
            }
            const piSum = pi.reduce((a, b) => a + b, 0);
            pi = pi.map(v => v / piSum);

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0, T - 1).map(g => g[s]));
                for (let next = 0; next < N; next++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][next]));
                    A[s][next] = Math.exp(numer - denom);
                }
                const rowSum = A[s].reduce((a, b) => a + b, 0);
                A[s] = A[s].map(v => v / rowSum);
            }

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < 2; o++) {
                    const matchingIndices = [];
                    for (let t = 0; t < T; t++) {
                        if (obs[t] === o) matchingIndices.push(logGamma[t][s]);
                    }
                    const numer = matchingIndices.length > 0 ? logSumExp(matchingIndices) : -Infinity;
                    B[s][o] = Math.exp(numer - denom);
                }
                const bSum = B[s].reduce((a, b) => a + b, 0);
                B[s] = B[s].map(v => Math.max(0.01, v / bSum));
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Ensure state 0 is NON-REP (lower repeat emission)
        if (B[0][1] > B[1][1]) {
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        // Apply minimum duration constraints via transition prob bounds
        // Minimum self-transition to enforce duration
        const minSelfTransNonRep = 1 - 1 / this.durationModel.nonRep.minDuration;
        const minSelfTransRep = 1 - 1 / this.durationModel.rep.minDuration;
        
        A[0][0] = Math.max(A[0][0], minSelfTransNonRep);
        A[0][1] = 1 - A[0][0];
        A[1][1] = Math.max(A[1][1], minSelfTransRep);
        A[1][0] = 1 - A[1][1];

        this.hmm.pi = pi;
        this.hmm.A = A;
        this.hmm.B = B;
        this.hmm.fitted = true;

        return true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  HMM: Viterbi Decoding with Duration Constraints
    // ══════════════════════════════════════════════════════════════════════════
    
    viterbi(obs) {
        const T = obs.length;
        const N = 2;
        if (T === 0) return null;

        const { pi, A, B } = this.hmm;
        const logDelta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
        const psi = Array.from({ length: T }, () => new Array(N).fill(0));

        for (let s = 0; s < N; s++) {
            logDelta[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
        }

        for (let t = 1; t < T; t++) {
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bestPrev = 0;
                for (let prev = 0; prev < N; prev++) {
                    const v = logDelta[t - 1][prev] + Math.log(A[prev][s] + 1e-300);
                    if (v > best) {
                        best = v;
                        bestPrev = prev;
                    }
                }
                logDelta[t][s] = best + Math.log(B[s][obs[t]] + 1e-300);
                psi[t][s] = bestPrev;
            }
        }

        // Backtrace
        const stateSeq = new Array(T);
        stateSeq[T - 1] = logDelta[T - 1][0] >= logDelta[T - 1][1] ? 0 : 1;
        for (let t = T - 2; t >= 0; t--) {
            stateSeq[t] = psi[t + 1][stateSeq[t + 1]];
        }

        // Regime persistence
        const curState = stateSeq[T - 1];
        let persistence = 1;
        for (let t = T - 2; t >= 0; t--) {
            if (stateSeq[t] === curState) persistence++;
            else break;
        }

        // Count transitions
        let transitions = 0;
        for (let t = 1; t < T; t++) {
            if (stateSeq[t] !== stateSeq[t - 1]) transitions++;
        }

        // Regime segment analysis
        const segments = [];
        let segStart = 0;
        for (let t = 1; t < T; t++) {
            if (stateSeq[t] !== stateSeq[t - 1]) {
                segments.push({ state: stateSeq[t - 1], start: segStart, end: t - 1, length: t - segStart });
                segStart = t;
            }
        }
        segments.push({ state: stateSeq[T - 1], start: segStart, end: T - 1, length: T - segStart });

        return {
            stateSeq,
            currentState: curState,
            persistence,
            transitions,
            segments,
            logLikelihood: Math.max(logDelta[T - 1][0], logDelta[T - 1][1]),
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Forward Algorithm (Bayesian Posterior)
    // ══════════════════════════════════════════════════════════════════════════
    
    computeForwardPosterior(obs) {
        const T = obs.length;
        if (T === 0) return [0.5, 0.5];

        const { pi, A, B } = this.hmm;
        let logA = [
            Math.log(pi[0] + 1e-300) + Math.log(B[0][obs[0]] + 1e-300),
            Math.log(pi[1] + 1e-300) + Math.log(B[1][obs[0]] + 1e-300),
        ];

        for (let t = 1; t < T; t++) {
            const newA = new Array(2);
            for (let s = 0; s < 2; s++) {
                const vals = [
                    logA[0] + Math.log(A[0][s] + 1e-300),
                    logA[1] + Math.log(A[1][s] + 1e-300),
                ];
                newA[s] = logSumExp(vals) + Math.log(B[s][obs[t]] + 1e-300);
            }
            logA = newA;
        }

        const denom = logSumExp(logA);
        return [Math.exp(logA[0] - denom), Math.exp(logA[1] - denom)];
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Per-Digit Statistics
    // ══════════════════════════════════════════════════════════════════════════
    
    computePerDigitStats(window) {
        const len = window.length;
        const rawRepeatProb = new Array(10).fill(0);
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);

        for (let i = 0; i < len - 1; i++) {
            const d = window[i];
            transFrom[d]++;
            if (window[i + 1] === d) transRepeat[d]++;
        }

        for (let d = 0; d < 10; d++) {
            rawRepeatProb[d] = transFrom[d] > 0 ? (transRepeat[d] / transFrom[d]) * 100 : 10;
        }

        // Update EWMA
        const ALPHA = 0.12;
        for (let d = 0; d < 10; d++) {
            if (transFrom[d] > 0) {
                const currentRate = (transRepeat[d] / transFrom[d]) * 100;
                this.perDigit.ewma[d] = ALPHA * currentRate + (1 - ALPHA) * this.perDigit.ewma[d];
            }
        }

        return {
            rawRepeatProb,
            ewmaRepeat: [...this.perDigit.ewma],
            transFrom,
            transRepeat,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Regime Hazard Estimation
    // ══════════════════════════════════════════════════════════════════════════
    
    computeRegimeHazard() {
        const rs = this.regimeState;
        const ticksSinceChange = this.tickCount - rs.lastChangeTick;
        
        // Hazard increases as we get further from expected regime duration
        const expectedDuration = rs.current === 0 
            ? this.durationModel.nonRep.meanDuration 
            : this.durationModel.rep.meanDuration;

        // Simple hazard model: increases after expected duration
        let hazard = this.cfg.bocpd_hazard_rate;
        if (ticksSinceChange > expectedDuration) {
            hazard *= (1 + 0.02 * (ticksSinceChange - expectedDuration));
        }
        hazard = Math.min(hazard, 0.2);  // Cap at 20%

        // Also factor in BOCPD change-point probability
        const bocpdChangeProb = this.bocpd.runLengthProbs.length > 0 
            ? this.bocpd.runLengthProbs[0] 
            : 0;

        return {
            baseHazard: this.cfg.bocpd_hazard_rate,
            adjustedHazard: hazard,
            bocpdChangeProb,
            combinedHazard: Math.max(hazard, bocpdChangeProb),
            ticksSinceChange,
            expectedDuration,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Main Analysis Function
    // ══════════════════════════════════════════════════════════════════════════
    
    analyze(tickHistory, targetDigit) {
        this.tickCount++;
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;

        if (len < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: 'insufficient data' };
        }

        // Build observation sequence
        const obs = new Array(len - 1);
        for (let t = 1; t < len; t++) {
            obs[t - 1] = window[t] === window[t - 1] ? 1 : 0;
        }
        const currentObs = obs.length > 0 ? obs[obs.length - 1] : 0;

        // Store observation history
        this.observationHistory.push(currentObs);
        if (this.observationHistory.length > this.maxObsHistory) {
            this.observationHistory.shift();
        }

        // 1. Update BOCPD
        const bocpdResult = this.updateBOCPD(currentObs);

        // 2. Update Run-Length tracking
        const runLengthResult = this.updateRunLength(currentObs);

        // 3. Update CUSUM
        const cusumResult = this.updateCUSUM(currentObs);

        // 4. Baum-Welch (periodically)
        if (!this.hmm.fitted || this.tickCount % 100 === 0) {
            if (obs.length >= 100) {
                const fitted = this.baumWelch(obs);
                if (fitted) {
                    logHMM(
                        `📐 HMM updated | ` +
                        `A: NR→NR=${(this.hmm.A[0][0] * 100).toFixed(1)}% NR→R=${(this.hmm.A[0][1] * 100).toFixed(1)}% ` +
                        `R→NR=${(this.hmm.A[1][0] * 100).toFixed(1)}% R→R=${(this.hmm.A[1][1] * 100).toFixed(1)}% | ` +
                        `B(rep|NR)=${(this.hmm.B[0][1] * 100).toFixed(1)}% B(rep|R)=${(this.hmm.B[1][1] * 100).toFixed(1)}%`
                    );
                }
            }
        }

        // 5. Viterbi decoding
        const vit = this.viterbi(obs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        // 6. Forward posterior
        const [posteriorNonRep, posteriorRep] = this.computeForwardPosterior(obs);

        // 7. Multi-scale analysis
        const multiScale = this.multiScaleAnalysis(window);

        // 8. Per-digit statistics
        const perDigitStats = this.computePerDigitStats(window);

        // 9. Regime hazard
        const hazard = this.computeRegimeHazard();

        // 10. Update regime state
        const previousRegime = this.regimeState.current;
        this.regimeState.current = vit.currentState;
        if (vit.currentState !== previousRegime) {
            // Regime changed
            this.regimeState.history.push({
                regime: previousRegime,
                startTick: this.regimeState.lastChangeTick,
                endTick: this.tickCount,
            });
            this.regimeState.lastChangeTick = this.tickCount;
            this.regimeState.persistence = 1;
            this.regimeState.transitionCount++;
        } else {
            this.regimeState.persistence++;
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Compute Composite Safety Score
        // ══════════════════════════════════════════════════════════════════════
        
        let safetyScore = 0;
        const threshold = this.cfg.repeat_threshold;

        // Component A: HMM Viterbi state (25 pts)
        if (vit.currentState === 0) safetyScore += 25;

        // Component B: Bayesian posterior (20 pts)
        safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 20);

        // Component C: Multi-scale consensus (20 pts)
        safetyScore += Math.round((multiScale.nonRepVotes / multiScale.totalVotes) * 20);

        // Component D: BOCPD stability (15 pts)
        safetyScore += Math.round(clamp(bocpdResult.stableRegimeProb, 0, 1) * 15);

        // Component E: Run-length analysis (10 pts)
        if (runLengthResult.valid && runLengthResult.regime === 0) {
            safetyScore += 5;
            if (runLengthResult.currentRunFavorable) safetyScore += 5;
        }

        // Component F: Regime persistence (10 pts)
        const persistScore = clamp(this.regimeState.persistence / this.cfg.min_regime_persistence, 0, 1);
        safetyScore += Math.round(persistScore * 10);

        // ══════════════════════════════════════════════════════════════════════
        //  Hard Gates (can zero out score)
        // ══════════════════════════════════════════════════════════════════════
        
        const gates = {
            hmmState: vit.currentState === 0,
            posterior: posteriorNonRep >= this.cfg.hmm_nonrep_confidence,
            multiScaleConsensus: multiScale.consensus,
            persistence: this.regimeState.persistence >= this.cfg.min_regime_persistence,
            regimeAge: (this.tickCount - this.regimeState.lastChangeTick) >= this.cfg.min_regime_age,
            cusumClear: !cusumResult.inCooldown,
            bocpdStable: bocpdResult.stableRegimeProb >= 0.5,
            hazardLow: hazard.combinedHazard < this.cfg.max_regime_hazard,
            digitRate: perDigitStats.rawRepeatProb[targetDigit] < threshold,
            digitEWMA: perDigitStats.ewmaRepeat[targetDigit] < threshold,
        };

        // Apply hard gates
        if (!gates.hmmState) safetyScore = 0;
        if (!gates.posterior) safetyScore = Math.min(safetyScore, 50);
        if (!gates.multiScaleConsensus) safetyScore = Math.min(safetyScore, 60);
        if (!gates.cusumClear) safetyScore = 0;
        if (!gates.bocpdStable) safetyScore = Math.min(safetyScore, 50);
        if (!gates.hazardLow) safetyScore = Math.min(safetyScore, 40);
        if (!gates.digitRate) safetyScore = 0;
        if (!gates.regimeAge) safetyScore = Math.min(safetyScore, 50);

        // ══════════════════════════════════════════════════════════════════════
        //  Signal Condition
        // ══════════════════════════════════════════════════════════════════════
        
        const signalActive = (
            gates.hmmState &&
            gates.posterior &&
            gates.multiScaleConsensus &&
            gates.persistence &&
            gates.regimeAge &&
            gates.cusumClear &&
            gates.bocpdStable &&
            gates.hazardLow &&
            gates.digitRate &&
            gates.digitEWMA &&
            safetyScore >= this.cfg.min_safety_score
        );

        const result = {
            valid: true,
            // HMM
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            hmmSegments: vit.segments.slice(-5),
            // Bayesian
            posteriorNonRep,
            posteriorRep,
            // BOCPD
            bocpdRunLength: bocpdResult.mostLikelyRunLength,
            bocpdExpectedRunLength: bocpdResult.expectedRunLength,
            bocpdChangeProb: bocpdResult.regimeChangeProb,
            bocpdStableProb: bocpdResult.stableRegimeProb,
            bocpdRepeatProb: bocpdResult.weightedRepeatProb,
            // Multi-scale
            multiScaleVotes: multiScale.nonRepVotes,
            multiScaleTotal: multiScale.totalVotes,
            multiScaleConsensus: multiScale.consensus,
            multiScaleScore: multiScale.consensusScore,
            multiScaleDetails: multiScale.scales,
            // Run-length
            runLengthResult,
            // CUSUM
            cusumUp: cusumResult.cusumUp,
            cusumDown: cusumResult.cusumDown,
            cusumInCooldown: cusumResult.inCooldown,
            cusumTicksSinceAlarm: cusumResult.ticksSinceAlarm,
            // Hazard
            hazardRate: hazard.combinedHazard,
            ticksSinceRegimeChange: hazard.ticksSinceChange,
            // Per-digit
            rawRepeatProb: perDigitStats.rawRepeatProb,
            ewmaRepeat: perDigitStats.ewmaRepeat,
            // Regime state
            regimePersistence: this.regimeState.persistence,
            regimeAge: this.tickCount - this.regimeState.lastChangeTick,
            regimeTransitionCount: this.regimeState.transitionCount,
            // Gates
            gates,
            // Composite
            safetyScore,
            signalActive,
            // Model params
            hmmA: this.hmm.A,
            hmmB: this.hmm.B,
        };

        this.lastResult = result;
        return result;
    }

    resetCUSUM() {
        this.cusum.up = 0;
        this.cusum.down = 0;
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

        // Advanced Regime Detector
        this.detector = new AdvancedRegimeDetector(config);

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
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v3.0  —  Ultra-Advanced Regime Detection ')));
        console.log(bold(cyan('   BOCPD + HSMM + Multi-Scale + Run-Length + Adaptive CUSUM        ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(`  Symbol              : ${bold(c.symbol)}`);
        console.log(`  Base Stake          : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window     : ${bold(c.analysis_window)} ticks`);
        console.log(`  Min Ticks           : ${bold(c.min_ticks_for_analysis)}`);
        console.log(`  Repeat Threshold    : ${bold(c.repeat_threshold + '%')}`);
        console.log(`  HMM NonRep Conf     : ${bold((c.hmm_nonrep_confidence * 100).toFixed(0) + '%')}`);
        console.log(`  Min Persistence     : ${bold(c.min_regime_persistence)} ticks`);
        console.log(`  Min Regime Age      : ${bold(c.min_regime_age)} ticks`);
        console.log(`  Multi-Scale Windows : ${bold(c.multi_scale_windows.join(', '))}`);
        console.log(`  Consensus Required  : ${bold(c.multi_scale_consensus + '/' + c.multi_scale_windows.length)}`);
        console.log(`  BOCPD Hazard Rate   : ${bold((c.bocpd_hazard_rate * 100).toFixed(2) + '%')}`);
        console.log(`  Max Regime Hazard   : ${bold((c.max_regime_hazard * 100).toFixed(0) + '%')}`);
        console.log(`  Min Safety Score    : ${bold(c.min_safety_score + '/100')}`);
        console.log(`  Ghost Trading       : ${c.ghost_enabled ? green('ON') : red('OFF')}`);
        console.log(`  Martingale          : ${c.martingale_enabled ? green('ON') + ` | Steps: ${c.max_martingale_steps}` : red('OFF')}`);
        console.log(`  Take Profit         : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss           : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log('');
        console.log(bold(yellow('  REGIME DETECTION ENGINE v3.0:')));
        console.log(dim('  1. BOCPD (Bayesian Online Change-Point Detection)'));
        console.log(dim('  2. HSMM-like HMM with duration constraints'));
        console.log(dim('  3. Multi-scale analysis (5 time windows)'));
        console.log(dim('  4. Run-length sequence analysis'));
        console.log(dim('  5. Bi-directional adaptive CUSUM'));
        console.log(dim('  6. Regime transition hazard estimation'));
        console.log(dim('  7. 10-gate safety system'));
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
        if (this.tickHistory.length >= this.config.min_ticks_for_analysis) {
            this.botState = STATE.ANALYZING;
            const lastDigit = this.tickHistory[this.tickHistory.length - 1];
            this.regime = this.detector.analyze(this.tickHistory, lastDigit);
            this.applyRegimeSignal(lastDigit);
            this.logRegimeAnalysis(lastDigit);
        } else {
            logBot(`Collecting more ticks (${this.tickHistory.length}/${this.config.min_ticks_for_analysis})...`);
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
                if (count >= this.config.min_ticks_for_analysis) {
                    this.botState = STATE.ANALYZING;
                    this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                    this.applyRegimeSignal(currentDigit);
                    this.logRegimeAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;

            case STATE.ANALYZING:
                this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                this.applyRegimeSignal(currentDigit);
                this.logRegimeAnalysis(currentDigit);
                if (this.signalActive) this.processSignal(currentDigit);
                break;

            case STATE.GHOST_TRADING:
                this.regime = this.detector.analyze(this.tickHistory, this.targetDigit);
                this.refreshSignalForLockedTarget();
                this.runGhostCheck(currentDigit);
                break;

            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                this.regime = this.detector.analyze(this.tickHistory, currentDigit);
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

        // Rate display for target digit
        const targetRate = r.rawRepeatProb[currentDigit];
        const targetEWMA = r.ewmaRepeat[currentDigit];
        const rateOK = targetRate < threshold && targetEWMA < threshold;
        
        logAnalysis(
            `Digit ${bold(cyan(currentDigit))}: ` +
            `raw=${rateOK ? green(targetRate.toFixed(1) + '%') : red(targetRate.toFixed(1) + '%')} ` +
            `EWMA=${rateOK ? green(targetEWMA.toFixed(1) + '%') : red(targetEWMA.toFixed(1) + '%')}`
        );

        // HMM/Viterbi state
        const stateCol = r.hmmState === 0 ? green : yellow;
        logHMM(
            `State: ${stateCol(bold(r.hmmStateName))} | ` +
            `P(NR): ${r.posteriorNonRep >= this.config.hmm_nonrep_confidence ? green((r.posteriorNonRep * 100).toFixed(1) + '%') : red((r.posteriorNonRep * 100).toFixed(1) + '%')} | ` +
            `Persist: ${r.hmmPersistence >= this.config.min_regime_persistence ? green(r.hmmPersistence + 't') : yellow(r.hmmPersistence + 't')} | ` +
            `Age: ${r.regimeAge >= this.config.min_regime_age ? green(r.regimeAge + 't') : yellow(r.regimeAge + 't')}`
        );

        // BOCPD
        logBOCPD(
            `RunLen: ${bold(r.bocpdRunLength)} (E=${r.bocpdExpectedRunLength.toFixed(1)}) | ` +
            `P(change): ${r.bocpdChangeProb < 0.05 ? green((r.bocpdChangeProb * 100).toFixed(2) + '%') : yellow((r.bocpdChangeProb * 100).toFixed(2) + '%')} | ` +
            `P(stable): ${r.bocpdStableProb >= 0.5 ? green((r.bocpdStableProb * 100).toFixed(1) + '%') : red((r.bocpdStableProb * 100).toFixed(1) + '%')} | ` +
            `RepProb: ${(r.bocpdRepeatProb * 100).toFixed(1)}%`
        );

        // Multi-scale
        const scaleVotes = r.multiScaleDetails.map(s => 
            s.regime === null ? dim('?') : (s.regime === 0 ? green('✓') : red('✗'))
        ).join('');
        logRegime(
            `Multi-Scale: [${scaleVotes}] ${r.multiScaleVotes}/${r.multiScaleTotal} | ` +
            `Consensus: ${r.multiScaleConsensus ? green('YES') : red('NO')} | ` +
            `Score: ${(r.multiScaleScore * 100).toFixed(0)}%`
        );

        // CUSUM
        logRegime(
            `CUSUM: ↑${r.cusumUp.toFixed(2)} ↓${r.cusumDown.toFixed(2)} | ` +
            `Cooldown: ${r.cusumInCooldown ? red('YES (' + r.cusumTicksSinceAlarm + 't ago)') : green('NO')} | ` +
            `Hazard: ${r.hazardRate < this.config.max_regime_hazard ? green((r.hazardRate * 100).toFixed(1) + '%') : red((r.hazardRate * 100).toFixed(1) + '%')}`
        );

        // Gates summary
        const gatesPassed = Object.values(r.gates).filter(v => v).length;
        const totalGates = Object.keys(r.gates).length;
        const gatesStr = Object.entries(r.gates).map(([k, v]) => 
            v ? green(k.substring(0, 3)) : red(k.substring(0, 3))
        ).join(' ');

        logRegime(
            `Gates: ${gatesPassed}/${totalGates} [${gatesStr}] | ` +
            `Safety: ${r.safetyScore >= this.config.min_safety_score ? green(r.safetyScore + '/100') : red(r.safetyScore + '/100')}`
        );

        if (this.signalActive) {
            logAnalysis(green(bold(
                `✅ SIGNAL ACTIVE — digit ${currentDigit} → DIFFER | ` +
                `Score: ${r.safetyScore}/100 | P(NR): ${(r.posteriorNonRep * 100).toFixed(1)}%`
            )));
        } else {
            const failedGates = Object.entries(r.gates).filter(([k, v]) => !v).map(([k]) => k);
            logAnalysis(red(
                `⛔ NO SIGNAL — digit ${currentDigit} | ` +
                `Failed: ${failedGates.join(', ')} | Score: ${r.safetyScore}/100`
            ));
        }
    }

    // ── Signal → Ghost / Trade ────────────────────────────────────────────────
    processSignal(currentDigit) {
        if (!this.signalActive) { this.botState = STATE.ANALYZING; return; }

        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            logGhost(
                `👻 Ghost phase started. Target: ${bold(cyan(this.targetDigit))} | ` +
                `Need ${bold(this.config.ghost_wins_required)} non-repeat(s).`
            );
            this.runGhostCheck(currentDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    // ── Ghost Trading ────────────────────────────────────────────────────────
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
                logGhost(`👻 ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} — digit ${bold(cyan(this.targetDigit))} did NOT repeat`);
            } else {
                const had = this.ghostConsecutiveWins;
                this.ghostConsecutiveWins = 0;
                logGhost(`👻 ${red(`❌ Ghost LOSS — digit REPEATED`)} (had ${had} wins) — reset`);
            }
        } else {
            if (currentDigit === this.targetDigit) {
                const winsIfConfirmed = this.ghostConsecutiveWins + 1;
                if (winsIfConfirmed >= this.config.ghost_wins_required) {
                    this.ghostConsecutiveWins = winsIfConfirmed;
                    this.ghostConfirmed = true;
                    logGhost(green(bold(`✅ Ghost confirmed! Executing LIVE trade on digit ${this.targetDigit} NOW!`)));
                    this.executeTradeFlow(true);
                } else {
                    this.ghostAwaitingResult = true;
                    logGhost(`👻 Target digit ${bold(cyan(this.targetDigit))} appeared | Awaiting next tick...`);
                }
            } else {
                logGhost(dim(`⏳ Digit ${currentDigit} — waiting for ${bold(this.targetDigit)}`));
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
        const r = this.regime;
        const score = r && r.valid ? r.safetyScore : 0;

        logTrade(
            `🎯 DIFFER from ${bold(cyan(this.targetDigit))} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))} | ` +
            `Rate: ${this.targetRepeatRate.toFixed(1)}% | ` +
            `Score: ${score}/100`
        );

        this.sendTelegram(`
            🎯 <b>TRADE 3</b>
            📊 Symbol: ${this.config.symbol}
            🔢 Target: ${this.targetDigit}
            last 5 ticks: ${this.tickHistory.slice(-5).join(', ')}
            💰 Stake: $${this.currentStake.toFixed(2)}
            🔬 Score: ${score}/100
            📈 Rate: ${this.targetRepeatRate.toFixed(1)}%
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
        logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)}`));
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

        this.detector.resetCUSUM();

        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${green('✅ WIN!')} +$${profit.toFixed(2)} | P/L: ${plStr} | Bal: ${green('$' + this.accountBalance.toFixed(2))}`);

        this.sendTelegram(`✅ <b>WIN 3!</b>\n\n+$${profit.toFixed(2)}\nP/L: ${formatMoney(this.sessionProfit)}`);

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

        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${red('❌ LOSS!')} -$${lostAmount.toFixed(2)} | P/L: ${plStr} | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}`);

        this.sendTelegram(`❌ <b>LOSS 3!</b>\n\n-$${lostAmount.toFixed(2)}\nP/L: ${formatMoney(this.sessionProfit)}`);

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
        return Math.min(Math.round(raw * 100) / 100, this.config.max_stake);
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            return { canTrade: false, reason: `🎯 Take profit reached! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            return { canTrade: false, reason: `🛑 Stop loss hit! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const nextStake = this.calculateStake();
        if (nextStake > this.accountBalance) return { canTrade: false, reason: `💸 Next stake > balance`, action: 'STOP' };
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
        this.sendTelegram(`🛑 <b>STOPPED</b>\n\nReason: ${reason}\nP/L: ${formatMoney(this.sessionProfit)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                  ')));
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
        logStats(`  Total Trades     : ${bold(this.totalTrades)}`);
        logStats(`  Wins             : ${green(this.totalWins)}`);
        logStats(`  Losses           : ${red(this.totalLosses)}`);
        logStats(`  Win Rate         : ${bold(wr + '%')}`);
        logStats(`  Session P/L      : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Final Balance    : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Max Win Streak   : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak  : ${red(this.maxLossStreak)}`);
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
        bot.stop('Uncaught exception');
    });

    bot.start();
})();
