#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT v2.0 — Multi-Asset Single-File Node.js
//  Advanced HMM + Bayesian + CUSUM Regime Detection
//  Trades 7 assets simultaneously: R_10, R_25, R_50, R_75, R_100, RDBULL, RDBEAR
//
//  Install:  npm install ws
//  Run:      node romanian-ghost-bot.js --token YOUR_DERIV_API_TOKEN [options]
//  Help:     node romanian-ghost-bot.js --help
// ============================================================================
'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

// ── ANSI Colours ──────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  blue:    '\x1b[34m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  orange:  '\x1b[38;5;208m',
  white:   '\x1b[37m',
};
const col    = (t, ...codes) => codes.join('') + t + C.reset;
const bold   = t => col(t, C.bold);
const dim    = t => col(t, C.dim);
const cyan   = t => col(t, C.cyan);
const blue   = t => col(t, C.blue);
const green  = t => col(t, C.green);
const red    = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta= t => col(t, C.magenta);
const orange = t => col(t, C.orange);

// ── Logger ────────────────────────────────────────────────────────────────────
const PREFIX_FN = {
  BOT:      cyan,
  API:      blue,
  TICK:     dim,
  ANALYSIS: yellow,
  GHOST:    magenta,
  TRADE:    t => col(t, C.bold, C.white),
  RESULT:   t => col(t, C.bold),
  RISK:     red,
  STATS:    cyan,
  ERROR:    t => col(t, C.bold, C.red),
  HMM:      orange,
};

function getTimestamp() {
  const n = new Date();
  return [
    String(n.getHours()).padStart(2,'0'),
    String(n.getMinutes()).padStart(2,'0'),
    String(n.getSeconds()).padStart(2,'0'),
  ].join(':');
}

function log(prefix, message) {
  const ts  = dim(`[${getTimestamp()}]`);
  const pfx = (PREFIX_FN[prefix] || (t => t))(`[${prefix}]`);
  console.log(`${ts} ${pfx} ${message}`);
}

const logBot      = m => log('BOT',      m);
const logApi      = m => log('API',      m);
const logTick     = m => log('TICK',     m);
const logAnalysis = m => log('ANALYSIS', m);
const logGhost    = m => log('GHOST',    m);
const logTrade    = m => log('TRADE',    m);
const logResult   = m => log('RESULT',   m);
const logRisk     = m => log('RISK',     m);
const logStats    = m => log('STATS',    m);
const logError    = m => log('ERROR',    m);
const logHMM      = m => log('HMM',      m);

// ── Utilities ─────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function logSumExp(arr) {
  const m = Math.max(...arr);
  if (!isFinite(m)) return -Infinity;
  return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

function getLastDigit(price, asset) {
  const parts = price.toString().split('.');
  const frac  = parts.length > 1 ? parts[1] : '';
  if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
    return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
  if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
    return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
  return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}

function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }

function formatDuration(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  return `${m}m ${String(s).padStart(2,'0')}s`;
}

// ── CLI argument parser ───────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i+1] !== undefined ? args[i+1] : def;
  };
  const has  = flag => args.includes(flag);

  if (has('--help') || has('-h')) {
    console.log(`
${bold(cyan('Romanian Ghost Bot v2.0 — Multi-Asset'))}

${bold('Usage:')}
  node romanian-ghost-bot.js --token YOUR_TOKEN [options]

${bold('Connection:')}
  --token   <string>   Deriv API token (required)
  --appid   <number>   App ID (default: 1089)

${bold('Assets:')}
  --assets  <csv>      Comma-separated list (default: R_10,R_25,R_50,R_75,R_100,RDBULL,RDBEAR)
                       Example: --assets R_10,R_50,R_100

${bold('Tick History:')}
  --history <number>   Tick history size per asset (default: 5000)
  --window  <number>   Analysis window size (default: 300)
  --min-ticks <number> Minimum ticks before HMM (default: 50)

${bold('HMM Regime Detection:')}
  --threshold <number> Repeat % threshold for signal (default: 8)
  --confidence <number> Min P(NON-REP) 0-1 (default: 0.90)
  --min-score <number> Min safety score 0-100 (default: 90)
  --persistence <number> Min regime persistence ticks (default: 8)
  --cusum <number>     CUSUM alarm threshold (default: 4.5)
  --cusum-slack <number> CUSUM slack (default: 0.005)

${bold('Trading:')}
  --stake   <number>   Base stake USD (default: 0.35)
  --symbol  <string>   Contract symbol (default: DIGITDIFF)
  --currency <string>  Currency (default: USD)

${bold('Ghost Trading:')}
  --no-ghost           Disable ghost trading
  --ghost-wins <number> Ghost wins required (default: 1)
  --ghost-max <number> Max ghost rounds (default: 999999)

${bold('Martingale:')}
  --no-mart            Disable martingale
  --mart-steps <number> Max martingale steps (default: 3)
  --mart-mult <number> Martingale multiplier (default: 11)
  --max-stake <number> Maximum stake (default: 500)

${bold('Risk:')}
  --tp <number>        Take profit USD (default: 10)
  --sl <number>        Stop loss USD (default: 50)
  --cooldown <number>  Cooldown ms after max loss (default: 30000)

${bold('Examples:')}
  node romanian-ghost-bot.js --token T0K3N
  node romanian-ghost-bot.js --token T0K3N --assets R_10,R_50 --stake 0.50 --tp 20
  node romanian-ghost-bot.js --token T0K3N --confidence 0.95 --min-score 95 --no-ghost
`);
    process.exit(0);
  }

  const token = '0P94g4WdSrSrzir';
  if (!token) {
    console.error(red('ERROR: --token is required. Run with --help for usage.'));
    process.exit(1);
  }

  const assetsArg = get('--assets', 'R_10,R_25,R_50,R_75,RDBULL,RDBEAR');
  const SUPPORTED = ['R_10','R_25','R_50','R_75','RDBULL','RDBEAR'];
  const activeAssets = assetsArg.split(',').map(s => s.trim()).filter(s => SUPPORTED.includes(s));
  if (activeAssets.length === 0) {
    console.error(red('ERROR: No valid assets specified.'));
    process.exit(1);
  }

  return {
    api_token:              token,
    app_id:                 '1089',
    endpoint:               'wss://ws.derivws.com/websockets/v3',
    active_assets:          activeAssets,
    base_stake:             0.61,
    currency:               'USD',
    contract_type:          'DIGITDIFF',
    tick_history_size:      5000,
    analysis_window:        5000,
    min_ticks_for_hmm:      50,
    repeat_threshold:       7,
    hmm_nonrep_confidence:  0.93,
    min_safety_score:       90,
    min_regime_persistence: 8,
    cusum_threshold:        4.5,
    cusum_slack:            0.005,
    ghost_enabled:          false,
    ghost_wins_required:    1,
    ghost_max_rounds:       999999,
    martingale_enabled:     true,
    martingale_multiplier:  11.3,
    max_martingale_steps:   3,
    max_stake:              500,
    take_profit:            10000,
    stop_loss:              50,
    cooldown_after_max_loss:30000,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  HMM REGIME DETECTOR — one instance per asset
//  2-State HMM: State 0 = NON-REP, State 1 = REP
// ══════════════════════════════════════════════════════════════════════════════
class HMMRegimeDetector {
  constructor(cfg) {
    this.cfg = cfg;
    // Initial HMM parameters (learned via Baum-Welch)
    this.pi = [0.6, 0.4];
    this.A  = [[0.90, 0.10], [0.25, 0.75]];
    this.B  = [[0.92, 0.08], [0.40, 0.60]]; // [state][obs]: obs=1 means repeat
    this.hmmFitted  = false;
    this.cusumValue = new Array(10).fill(0); // per-digit CUSUM
  }

  // ── Baum-Welch EM parameter estimation ────────────────────────────────────
  baumWelch(obs, maxIter = 20, tol = 1e-5) {
    const T = obs.length;
    if (T < 10) return false;
    const N = 2;
    let pi = [...this.pi];
    let A  = this.A.map(r => [...r]);
    let B  = this.B.map(r => [...r]);
    let prevLogL = -Infinity;

    for (let iter = 0; iter < maxIter; iter++) {
      // Forward pass (log-space)
      const logAlpha = Array.from({length: T}, () => new Array(N).fill(-Infinity));
      for (let s = 0; s < N; s++)
        logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
      for (let t = 1; t < T; t++)
        for (let s = 0; s < N; s++) {
          const inc = A.map((row, p) => logAlpha[t-1][p] + Math.log(row[s] + 1e-300));
          logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]] + 1e-300);
        }
      const logL = logSumExp(logAlpha[T-1]);

      // Backward pass (log-space)
      const logBeta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
      for (let s = 0; s < N; s++) logBeta[T-1][s] = 0;
      for (let t = T-2; t >= 0; t--)
        for (let s = 0; s < N; s++) {
          const vals = A[s].map((a, nx) =>
            Math.log(a + 1e-300) + Math.log(B[nx][obs[t+1]] + 1e-300) + logBeta[t+1][nx]
          );
          logBeta[t][s] = logSumExp(vals);
        }

      // Gamma (state occupancy)
      const logGamma = Array.from({length: T}, () => new Array(N).fill(-Infinity));
      for (let t = 0; t < T; t++) {
        const den = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
        for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - den;
      }

      // Xi (transition occupancy)
      const logXi = Array.from({length: T-1}, () =>
        Array.from({length: N}, () => new Array(N).fill(-Infinity))
      );
      for (let t = 0; t < T-1; t++) {
        const den = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
        for (let s = 0; s < N; s++)
          for (let nx = 0; nx < N; nx++)
            logXi[t][s][nx] = logAlpha[t][s] + Math.log(A[s][nx] + 1e-300) +
              Math.log(B[nx][obs[t+1]] + 1e-300) + logBeta[t+1][nx] - den;
      }

      // M-step: re-estimate pi, A, B
      for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
      const piSum = pi.reduce((a, b) => a + b, 0);
      pi = pi.map(v => v / piSum);

      for (let s = 0; s < N; s++) {
        const den = logSumExp(logGamma.slice(0, T-1).map(g => g[s]));
        for (let nx = 0; nx < N; nx++) {
          const num = logSumExp(logXi.map(xi => xi[s][nx]));
          A[s][nx] = Math.exp(num - den);
        }
        const rs = A[s].reduce((a, b) => a + b, 0);
        A[s] = A[s].map(v => v / rs);
      }
      for (let s = 0; s < N; s++) {
        const den = logSumExp(logGamma.map(g => g[s]));
        for (let o = 0; o < 2; o++) {
          const num = logSumExp(logGamma.filter((_, t) => obs[t] === o).map(g => g[s]));
          B[s][o] = Math.exp(num - den);
        }
        const bs = B[s].reduce((a, b) => a + b, 0);
        B[s] = B[s].map(v => v / bs);
      }

      if (Math.abs(logL - prevLogL) < tol) break;
      prevLogL = logL;
    }

    // Ensure State 0 = NON-REP (lower repeat emission)
    if (B[0][1] > B[1][1]) {
      [pi[0], pi[1]] = [pi[1], pi[0]];
      [A[0],  A[1]]  = [A[1],  A[0]];
      A[0] = [A[0][1], A[0][0]];
      A[1] = [A[1][1], A[1][0]];
      [B[0],  B[1]]  = [B[1],  B[0]];
    }

    this.pi = pi; this.A = A; this.B = B;
    this.hmmFitted = true;
    return true;
  }

  // ── Viterbi decoding ───────────────────────────────────────────────────────
  viterbi(obs) {
    const T = obs.length, N = 2;
    if (T === 0) return null;
    const logDelta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
    const psi      = Array.from({length: T}, () => new Array(N).fill(0));
    for (let s = 0; s < N; s++)
      logDelta[0][s] = Math.log(this.pi[s] + 1e-300) + Math.log(this.B[s][obs[0]] + 1e-300);
    for (let t = 1; t < T; t++)
      for (let s = 0; s < N; s++) {
        let best = -Infinity, bestP = 0;
        for (let p = 0; p < N; p++) {
          const v = logDelta[t-1][p] + Math.log(this.A[p][s] + 1e-300);
          if (v > best) { best = v; bestP = p; }
        }
        logDelta[t][s] = best + Math.log(this.B[s][obs[t]] + 1e-300);
        psi[t][s] = bestP;
      }
    const stateSeq = new Array(T);
    stateSeq[T-1] = logDelta[T-1][0] >= logDelta[T-1][1] ? 0 : 1;
    for (let t = T-2; t >= 0; t--) stateSeq[t] = psi[t+1][stateSeq[t+1]];
    const curState = stateSeq[T-1];
    let persistence = 1;
    for (let t = T-2; t >= 0; t--) { if (stateSeq[t] === curState) persistence++; else break; }
    let transitions = 0;
    for (let t = 1; t < T; t++) if (stateSeq[t] !== stateSeq[t-1]) transitions++;
    return { stateSeq, currentState: curState, persistence, transitions };
  }

  // ── CUSUM change-point detector ────────────────────────────────────────────
  updateCUSUM(digit, obs_t) {
    const llr = Math.log(this.B[1][obs_t] + 1e-300) - Math.log(this.B[0][obs_t] + 1e-300);
    this.cusumValue[digit] = Math.max(0, this.cusumValue[digit] + llr - this.cfg.cusum_slack);
    return this.cusumValue[digit] > this.cfg.cusum_threshold;
  }
  resetCUSUM(digit) { this.cusumValue[digit] = 0; }
  getCUSUMValue(digit) { return this.cusumValue[digit]; }

  // ── Per-digit stats (raw prob + EWMA) ─────────────────────────────────────
  computePerDigitStats(window) {
    const len   = window.length;
    const ALPHA = 0.15;
    const transFrom   = new Array(10).fill(0);
    const transRepeat = new Array(10).fill(0);
    const ewmaRepeat  = new Array(10).fill(null);
    for (let i = 0; i < len; i++) {
      const d = window[i];
      const isRepeat = i > 0 && window[i] === window[i-1];
      if (ewmaRepeat[d] === null) ewmaRepeat[d] = isRepeat ? 100 : 0;
      else ewmaRepeat[d] = ALPHA * (isRepeat ? 100 : 0) + (1 - ALPHA) * ewmaRepeat[d];
    }
    for (let i = 0; i < len - 1; i++) {
      transFrom[window[i]]++;
      if (window[i+1] === window[i]) transRepeat[window[i]]++;
    }
    const rawRepeatProb = new Array(10).fill(0);
    for (let d = 0; d < 10; d++) {
      rawRepeatProb[d] = transFrom[d] > 0 ? (transRepeat[d] / transFrom[d]) * 100 : 10;
      if (ewmaRepeat[d] === null) ewmaRepeat[d] = 10;
    }
    return { rawRepeatProb, ewmaRepeat };
  }

  // ── Full regime analysis ───────────────────────────────────────────────────
  analyze(tickHistory, targetDigit, tickCount) {
    const window = tickHistory.slice(-this.cfg.analysis_window);
    const len    = window.length;
    if (len < this.cfg.min_ticks_for_hmm)
      return { valid: false, reason: `Insufficient data (${len}/${this.cfg.min_ticks_for_hmm})` };

    // Binary observation: 1 = repeat, 0 = no repeat
    const obs = new Array(len - 1);
    for (let t = 1; t < len; t++) obs[t-1] = window[t] === window[t-1] ? 1 : 0;

    // Re-fit HMM every 50 ticks
    if (!this.hmmFitted || tickCount % 50 === 0) {
      const ok = this.baumWelch(obs);
      if (ok) {
        logHMM(
          `HMM refitted | ` +
          `A[NR→NR]=${(this.A[0][0]*100).toFixed(1)}% A[NR→R]=${(this.A[0][1]*100).toFixed(1)}% ` +
          `A[R→NR]=${(this.A[1][0]*100).toFixed(1)}% A[R→R]=${(this.A[1][1]*100).toFixed(1)}% | ` +
          `B(rep|NR)=${(this.B[0][1]*100).toFixed(1)}% B(rep|R)=${(this.B[1][1]*100).toFixed(1)}%`
        );
      }
    }

    // Viterbi
    const vit = this.viterbi(obs);
    if (!vit) return { valid: false, reason: 'Viterbi failed' };

    // Forward (Bayesian posterior)
    let logA = [
      Math.log(this.pi[0] + 1e-300) + Math.log(this.B[0][obs[0]] + 1e-300),
      Math.log(this.pi[1] + 1e-300) + Math.log(this.B[1][obs[0]] + 1e-300),
    ];
    for (let t = 1; t < obs.length; t++) {
      const newA = [0, 0];
      for (let s = 0; s < 2; s++) {
        newA[s] = logSumExp([
          logA[0] + Math.log(this.A[0][s] + 1e-300),
          logA[1] + Math.log(this.A[1][s] + 1e-300),
        ]) + Math.log(this.B[s][obs[t]] + 1e-300);
      }
      logA = newA;
    }
    const fwdDen       = logSumExp(logA);
    const posteriorNonRep = Math.exp(logA[0] - fwdDen);
    const posteriorRep    = Math.exp(logA[1] - fwdDen);

    // CUSUM update for target digit on recent ticks
    const recentLen = Math.min(len, 30);
    const recentWin = window.slice(-recentLen);
    let cusumAlarm = false;
    for (let t = 1; t < recentLen; t++) {
      const obs_t = recentWin[t] === recentWin[t-1] ? 1 : 0;
      if (recentWin[t-1] === targetDigit || recentWin[t] === targetDigit)
        cusumAlarm = this.updateCUSUM(targetDigit, obs_t);
    }
    const cusumValue = this.getCUSUMValue(targetDigit);

    // Per-digit stats
    const { rawRepeatProb, ewmaRepeat } = this.computePerDigitStats(window);

    // Recent repeat rate (last 20 ticks)
    const shortWin = window.slice(-20);
    let rcRepeat = 0, rcTotal = 0;
    for (let i = 1; i < shortWin.length; i++) {
      if (shortWin[i-1] === targetDigit || shortWin[i] === targetDigit) {
        rcTotal++;
        if (shortWin[i] === shortWin[i-1]) rcRepeat++;
      }
    }
    const recentRepeatRate = rcTotal > 0 ? (rcRepeat / rcTotal) * 100 : rawRepeatProb[targetDigit];

    // Regime stability: 5-segment analysis
    const seqLen  = vit.stateSeq.length;
    const segSize = Math.floor(seqLen / 5);
    const segFracs = [];
    for (let seg = 0; seg < 5 && seg * segSize < seqLen; seg++) {
      const sl = vit.stateSeq.slice(seg * segSize, (seg + 1) * segSize);
      segFracs.push(sl.filter(s => s === 0).length / sl.length);
    }
    const regimeStability = segFracs.reduce((a, b) => a + b, 0) / segFracs.length;

    // Composite safety score (0-100)
    const threshold = this.cfg.repeat_threshold;
    let safetyScore = 0;
    if (vit.currentState === 0) safetyScore += 40;
    safetyScore += Math.round(clamp((posteriorNonRep - 0.5) / 0.5, 0, 1) * 30);
    safetyScore += Math.round(clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1) * 15);
    safetyScore += Math.round(regimeStability * 15);
    // Hard gates
    if (vit.currentState !== 0)                           safetyScore = 0;
    if (posteriorNonRep < this.cfg.hmm_nonrep_confidence) safetyScore = Math.min(safetyScore, this.cfg.min_safety_score - 1);
    if (rawRepeatProb[targetDigit] >= threshold)          safetyScore = 0;
    if (cusumAlarm)                                       safetyScore = 0;

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

    return {
      valid: true,
      hmmState:        vit.currentState,
      hmmStateName:    vit.currentState === 0 ? 'NON-REP' : 'REP',
      hmmPersistence:  vit.persistence,
      hmmTransitions:  vit.transitions,
      regimeStability,
      posteriorNonRep,
      posteriorRep,
      cusumAlarm,
      cusumValue,
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
//  MULTI-ASSET GHOST BOT
// ══════════════════════════════════════════════════════════════════════════════
class RomanianGhostBot {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.botState = 'INITIALIZING';
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT = 5;
    this.pingInterval  = null;
    this.cooldownTimer = null;
    this.requestId     = 0;

    // Account
    this.accountBalance  = 0;
    this.startingBalance = 0;
    this.accountId       = '';

    // Per-asset maps
    this.assetStates = new Map(); // symbol → AssetState
    this.assetHMMs   = new Map(); // symbol → HMMRegimeDetector

    // Telegram
    this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

    // Global trade state
    this.isTradeActive       = false;
    this.activeTradeAsset    = null;
    this.currentStake        = 0;
    this.martingaleStep      = 0;
    this.totalMartingaleLoss = 0;
    this.lastBuyPrice        = 0;
    this.lastContractId      = null;
    this.tradeRegimeSnapshot = null;
    this.tradePendingAsset   = null;

    // Session stats
    this.sessionStartTime    = Date.now();
    this.totalTrades         = 0;
    this.totalWins           = 0;
    this.totalLosses         = 0;
    this.sessionProfit       = 0;
    this.currentWinStreak    = 0;
    this.currentLossStreak   = 0;
    this.maxWinStreak        = 0;
    this.maxLossStreak       = 0;
    this.maxMartingaleReached= 0;
    this.largestWin          = 0;
    this.largestLoss         = 0;
  }

  // ── Asset initialisation ───────────────────────────────────────────────────
  initAssetStates() {
    this.assetStates.clear();
    this.assetHMMs.clear();
    for (const sym of this.config.active_assets) {
      this.assetStates.set(sym, {
        symbol:               sym,
        tickHistory:          [],
        tickCount:            0,
        regime:               null,
        targetDigit:          -1,
        targetRepeatRate:     0,
        signalActive:         false,
        ghostConsecutiveWins: 0,
        ghostRoundsPlayed:    0,
        ghostConfirmed:       false,
        ghostAwaitingResult:  false,
        ready:                false,
        subscribed:           false,
      });
      this.assetHMMs.set(sym, new HMMRegimeDetector(this.config));
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  start() {
    this.initAssetStates();
    this.sessionStartTime = Date.now();
    this.printBanner();
    this.connectWS();
  }

  printBanner() {
    const c = this.config;
    console.log('');
    console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
    console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v2.0 — Multi-Asset Node.js          ')));
    console.log(bold(cyan('   HMM + Bayesian + CUSUM Regime Detection                    ')));
    console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
    console.log(`  ${bold('Active Assets')}      : ${bold(cyan(c.active_assets.join(', ')))}`);
    console.log(`  ${bold('Base Stake')}         : ${bold(green('$' + c.base_stake.toFixed(2)))}`);
    console.log(`  ${bold('History/Window')}     : ${bold(c.tick_history_size)} / ${bold(c.analysis_window)} ticks`);
    console.log(`  ${bold('Min Ticks HMM')}      : ${bold(c.min_ticks_for_hmm)}`);
    console.log(`  ${bold('Repeat Threshold')}   : ${bold(c.repeat_threshold + '%')}`);
    console.log(`  ${bold('HMM P(NR) Min')}      : ${bold((c.hmm_nonrep_confidence*100).toFixed(0) + '%')}`);
    console.log(`  ${bold('Min Safety Score')}   : ${bold(c.min_safety_score + '/100')}`);
    console.log(`  ${bold('Min Persistence')}    : ${bold(c.min_regime_persistence + ' ticks')}`);
    console.log(`  ${bold('CUSUM Threshold')}    : ${bold(c.cusum_threshold)}`);
    console.log(`  ${bold('Ghost Trading')}      : ${c.ghost_enabled ? green('ON') + ` | Wins: ${bold(c.ghost_wins_required)}` : red('OFF')}`);
    console.log(`  ${bold('Martingale')}         : ${c.martingale_enabled ? green('ON') + ` | Steps: ${c.max_martingale_steps} | Mult: ${c.martingale_multiplier}x` : red('OFF')}`);
    console.log(`  ${bold('Take Profit')}        : ${green('$' + c.take_profit.toFixed(2))}`);
    console.log(`  ${bold('Stop Loss')}          : ${red('$' + c.stop_loss.toFixed(2))}`);
    console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
    console.log('');
    console.log(bold(yellow('  MULTI-ASSET STRATEGY:')));
    console.log(dim('  • Each asset runs its own independent HMM regime detector'));
    console.log(dim('  • All assets analyzed simultaneously on one WebSocket connection'));
    console.log(dim('  • Only ONE trade fires at a time across all assets'));
    console.log(dim('  • After any trade (win/loss), ALL asset ghost states reset'));
    console.log(dim('  • Ghost phase: wait for target digit to appear N times without repeating'));
    console.log(dim('  • Trade fires immediately when ghost wins reach required count'));
    console.log('');
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  connectWS() {
    this.botState = 'CONNECTING';
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
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
      }, 30_000);
      this.botState = 'AUTHENTICATING';
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
      if (this.botState !== 'STOPPED') this.attemptReconnect();
    });

    this.ws.on('error', e => logError(`WebSocket error: ${e.message}`));
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      logError(`Max reconnection attempts reached.`);
      this.stop('Max reconnect attempts exceeded');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
    logApi(`Reconnecting in ${delay/1000}s (${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
    this.isTradeActive = false;
    setTimeout(() => { if (this.botState !== 'STOPPED') this.connectWS(); }, delay);
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

  // ── Message router ─────────────────────────────────────────────────────────
  handleMessage(msg) {
    if (msg.error) { this.handleApiError(msg); return; }
    switch (msg.msg_type) {
      case 'authorize':   this.handleAuth(msg);        break;
      case 'balance':     this.handleBalance(msg);     break;
      case 'history':     this.handleTickHistory(msg); break;
      case 'tick':        this.handleTick(msg);        break;
      case 'buy':         this.handleBuy(msg);         break;
      case 'transaction': this.handleTransaction(msg); break;
      case 'ping': break;
    }
  }

  handleApiError(msg) {
    const code = (msg.error && msg.error.code)    || 'UNKNOWN';
    const emsg = (msg.error && msg.error.message) || 'Unknown error';
    logError(`[${code}] on ${msg.msg_type || 'unknown'}: ${emsg}`);
    switch (code) {
      case 'InvalidToken':
      case 'AuthorizationRequired': this.stop('Authentication failed'); break;
      case 'InsufficientBalance':   this.stop('Insufficient balance');  break;
      case 'RateLimit':
        logError('Rate limited — pausing 10s...');
        setTimeout(() => { if (this.botState !== 'STOPPED') { this.isTradeActive = false; } }, 10_000);
        break;
      default:
        if (msg.msg_type === 'buy') {
          this.isTradeActive    = false;
          this.activeTradeAsset = null;
          logError('Buy failed — returning to analysis');
        }
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  handleAuth(msg) {
    if (!msg.authorize) return;
    const auth = msg.authorize;
    this.accountBalance  = parseFloat(auth.balance);
    this.startingBalance = this.accountBalance;
    this.accountId       = auth.loginid || 'N/A';
    const isDemo = this.accountId.startsWith('VRTC');
    logApi(
      `${green('✅ Authenticated')} | Account: ${bold(this.accountId)} ` +
      `${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | ` +
      `Balance: ${green('$' + this.accountBalance.toFixed(2))}`
    );
    if (!isDemo) logRisk(red('⚠️  REAL ACCOUNT — trading with real money!'));

    this.send({ balance: 1, subscribe: 1 });
    this.send({ transaction: 1, subscribe: 1 });

    // Fetch history for all active assets
    this.botState = 'COLLECTING_TICKS';
    logBot(`Fetching tick history for ${bold(this.config.active_assets.length)} assets...`);
    for (const sym of this.config.active_assets) {
      this.send({
        ticks_history: sym,
        count:         this.config.tick_history_size,
        end:           'latest',
        style:         'ticks',
      });
    }
  }

  // ── Tick History ───────────────────────────────────────────────────────────
  handleTickHistory(msg) {
    const echoReq = msg.echo_req || {};
    const sym     = echoReq.ticks_history || '';
    const st      = this.assetStates.get(sym);
    if (!st) return;

    if (!msg.history || !msg.history.prices) {
      logError(`Failed to fetch history for ${sym} — subscribing anyway`);
      this.subscribeToLiveTicks(sym, st);
      return;
    }

    const prices = msg.history.prices;
    const digits = prices.map(p => getLastDigit(p, sym));
    st.tickHistory = digits.slice(-this.config.tick_history_size);
    st.tickCount   = st.tickHistory.length;
    logBot(`${green('✅')} ${bold(sym)}: Loaded ${bold(st.tickHistory.length)} ticks | tail: [${st.tickHistory.slice(-8).join(',')}]`);

    if (st.tickHistory.length >= this.config.min_ticks_for_hmm) {
      st.ready = true;
      const last = st.tickHistory[st.tickHistory.length - 1];
      const hmm  = this.assetHMMs.get(sym);
      st.regime  = hmm.analyze(st.tickHistory, last, st.tickCount);
      this.applyRegimeSignal(st, last);
    }

    this.subscribeToLiveTicks(sym, st);
    this.checkAllAssetsReady();
  }

  subscribeToLiveTicks(sym, st) {
    if (st.subscribed) return;
    st.subscribed = true;
    logBot(`Subscribing to live ticks: ${bold(sym)}`);
    this.send({ ticks: sym, subscribe: 1 });
  }

  checkAllAssetsReady() {
    const readyCount = [...this.assetStates.values()].filter(s => s.ready).length;
    const total      = this.config.active_assets.length;
    if (readyCount === total && this.botState !== 'TRADING' && this.botState !== 'STOPPED') {
      logBot(green(`✅ All ${total} assets ready — entering ANALYZING mode`));
      this.botState = 'ANALYZING';
    } else if (readyCount < total) {
      logBot(`Assets ready: ${readyCount}/${total}`);
    }
  }

  // ── Balance ────────────────────────────────────────────────────────────────
  handleBalance(msg) {
    if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
  }

  // ── Live Tick ──────────────────────────────────────────────────────────────
  handleTick(msg) {
    if (this.botState === 'STOPPED') return;
    if (!msg.tick) return;

    const sym          = msg.tick.symbol;
    const price        = parseFloat(msg.tick.quote);
    const currentDigit = getLastDigit(price, sym);
    const st           = this.assetStates.get(sym);
    if (!st) return;

    // Maintain sliding window
    st.tickHistory.push(currentDigit);
    if (st.tickHistory.length > this.config.tick_history_size)
      st.tickHistory = st.tickHistory.slice(-this.config.tick_history_size);
    st.tickCount++;

    // Log tick for interesting states
    const isGhostActive = st.ghostConsecutiveWins > 0 || st.ghostAwaitingResult;
    if (isGhostActive || st.signalActive) {
      const last5 = st.tickHistory.slice(Math.max(0, st.tickHistory.length - 6), st.tickHistory.length - 1);
      logTick(
        `[${bold(sym)}] ${dim(last5.join('›')+'›')} ${bold(cyan(`[${currentDigit}]`))}` +
        dim(`  ${price}  (${st.tickCount})`) +
        (st.ghostConsecutiveWins > 0
          ? `  ${magenta(`👻 ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`
          : '')
      );
    }

    // Become ready if enough ticks have accumulated
    if (!st.ready && st.tickHistory.length >= this.config.min_ticks_for_hmm) {
      st.ready = true;
      this.checkAllAssetsReady();
    }
    if (!st.ready) return;

    const hmm = this.assetHMMs.get(sym);

    // If trade is active — still analyze but don't trade
    if (this.isTradeActive) {
      st.regime = hmm.analyze(st.tickHistory, currentDigit, st.tickCount);
      return;
    }

    // Ghost confirmed — waiting for target digit to fire pending trade
    if (st.ghostConfirmed) {
      st.regime = hmm.analyze(st.tickHistory, st.targetDigit, st.tickCount);
      this.refreshSignalForLockedTarget(st, hmm);
      if (!st.signalActive) {
        logGhost(`[${sym}] Signal lost after ghost confirm — resetting`);
        this.resetAssetGhost(st);
        return;
      }
      if (this.tradePendingAsset === sym) {
        if (currentDigit === st.targetDigit) {
          this.tradePendingAsset = null;
          this.executeTradeForAsset(st, hmm, true);
        } else {
          logGhost(dim(`[${sym}] ⏳ Waiting for digit ${bold(st.targetDigit)} — got ${currentDigit}`));
        }
      }
      return;
    }

    // Ghost awaiting result (Tick B)
    if (st.ghostAwaitingResult) {
      st.regime = hmm.analyze(st.tickHistory, st.targetDigit, st.tickCount);
      this.refreshSignalForLockedTarget(st, hmm);
      this.runGhostTickB(st, currentDigit);
      return;
    }

    // Standard analysis path
    st.regime = hmm.analyze(st.tickHistory, currentDigit, st.tickCount);
    this.applyRegimeSignal(st, currentDigit);
    this.logRegimeAnalysis(st, currentDigit);

    if (st.signalActive) {
      if (this.config.ghost_enabled) {
        this.runGhostTickA(st, currentDigit);
      } else {
        this.executeTradeForAsset(st, hmm, true);
      }
    }
  }

  // ── Signal helpers ─────────────────────────────────────────────────────────
  applyRegimeSignal(st, currentDigit) {
    st.targetDigit      = currentDigit;
    st.targetRepeatRate = 0;
    st.signalActive     = false;
    if (!st.regime || !st.regime.valid) return;
    st.targetRepeatRate = st.regime.rawRepeatProb[currentDigit];
    st.signalActive     = st.regime.signalActive;
  }

  refreshSignalForLockedTarget(st, _hmm) {
    if (st.targetDigit < 0 || !st.regime || !st.regime.valid) { st.signalActive = false; return; }
    st.targetRepeatRate = st.regime.rawRepeatProb[st.targetDigit];
    st.signalActive     = st.regime.signalActive;
  }

  // ── Ghost Tick A (target digit just appeared) ──────────────────────────────
  runGhostTickA(st, currentDigit) {
    if (currentDigit !== st.targetDigit) return;
    if (this.isTradeActive) {
      logGhost(`[${st.symbol}] Trade active — skipping ghost tick`);
      return;
    }

    st.ghostRoundsPlayed++;
    const winsIfConfirmed = st.ghostConsecutiveWins + 1;

    if (winsIfConfirmed >= this.config.ghost_wins_required) {
      st.ghostConsecutiveWins = winsIfConfirmed;
      st.ghostConfirmed       = true;
      logGhost(
        `[${bold(st.symbol)}] 👻 ${green(`✅ Ghost WIN ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} ` +
        `— Target ${bold(cyan(st.targetDigit))} appeared! ${green(bold('EXECUTING LIVE TRADE NOW!'))}`
      );
      const hmm = this.assetHMMs.get(st.symbol);
      this.executeTradeForAsset(st, hmm, true);
    } else {
      st.ghostAwaitingResult = true;
      logGhost(
        `[${bold(st.symbol)}] 👻 Target ${bold(cyan(st.targetDigit))} appeared | ` +
        `Wins: ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required} | ` +
        dim('Awaiting next tick (Tick B)...')
      );
    }
  }

  // ── Ghost Tick B (result — did the digit repeat?) ─────────────────────────
  runGhostTickB(st, currentDigit) {
    st.ghostAwaitingResult = false;
    if (currentDigit !== st.targetDigit) {
      // Did NOT repeat → Ghost WIN ✅
      st.ghostConsecutiveWins++;
      logGhost(
        `[${bold(st.symbol)}] 👻 ${green(`✅ Ghost WIN ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} ` +
        `— ${bold(cyan(st.targetDigit))} did NOT repeat (next was ${bold(currentDigit)})`
      );
    } else {
      // REPEATED → Ghost LOSS ❌
      const had = st.ghostConsecutiveWins;
      st.ghostConsecutiveWins = 0;
      logGhost(
        `[${bold(st.symbol)}] 👻 ${red(`❌ Ghost LOSS — digit REPEATED!`)} ` +
        `(had ${had} wins) — reset 0/${this.config.ghost_wins_required}`
      );
    }

    if (st.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
      logGhost(`[${st.symbol}] ⚠️  Max ghost rounds (${this.config.ghost_max_rounds}) reached — resetting`);
      this.resetAssetGhost(st);
    }
  }

  resetAssetGhost(st) {
    st.ghostConsecutiveWins = 0;
    st.ghostRoundsPlayed    = 0;
    st.ghostConfirmed       = false;
    st.ghostAwaitingResult  = false;
    st.targetDigit          = -1;
    st.signalActive         = false;
  }

  // ── Trade Execution ────────────────────────────────────────────────────────
  executeTradeForAsset(st, _hmm, immediate) {
    if (this.isTradeActive) {
      logGhost(`[${st.symbol}] ⏳ Trade already active on ${this.activeTradeAsset} — queuing`);
      this.tradePendingAsset = st.symbol;
      st.ghostConfirmed = true;
      return;
    }

    const risk = this.checkRiskLimits();
    if (!risk.canTrade) {
      logRisk(risk.reason);
      if (risk.action === 'STOP')     { this.stop(risk.reason);    return; }
      if (risk.action === 'COOLDOWN') { this.startCooldown();      return; }
      return;
    }

    this.currentStake = this.calculateStake();
    if (this.currentStake > this.config.max_stake) {
      this.stop(`Stake $${this.currentStake.toFixed(2)} exceeds max $${this.config.max_stake}`);
      return;
    }
    if (this.currentStake > this.accountBalance) {
      this.stop(`Stake $${this.currentStake.toFixed(2)} exceeds balance $${this.accountBalance.toFixed(2)}`);
      return;
    }

    if (immediate) {
      this.placeTrade(st);
    } else {
      this.tradePendingAsset = st.symbol;
      st.ghostConfirmed = true;
      logBot(`[${st.symbol}] ⚡ Trade queued — waiting for digit ${bold(cyan(st.targetDigit))}`);
    }
  }

  placeTrade(st) {
    // Snapshot regime at trade time
    this.tradeRegimeSnapshot = st.regime ? { ...st.regime } : null;
    const snap      = this.tradeRegimeSnapshot;
    const snapScore = snap && snap.valid ? (snap.safetyScore || 0) : 0;
    const snapPNR   = snap && snap.valid ? (snap.posteriorNonRep || 0) : 0;

    // Hard gate: verify score and P(NR) still meet configured minimums
    if (snapScore < this.config.min_safety_score) {
      logRisk(`[${st.symbol}] 🚫 Trade BLOCKED — Score ${snapScore} < ${this.config.min_safety_score}. Re-analyzing...`);
      this.resetAssetGhost(st);
      return;
    }
    if (snapPNR < this.config.hmm_nonrep_confidence) {
      logRisk(
        `[${st.symbol}] 🚫 Trade BLOCKED — ` +
        `P(NR) ${(snapPNR*100).toFixed(1)}% < ${(this.config.hmm_nonrep_confidence*100).toFixed(0)}%. Re-analyzing...`
      );
      this.resetAssetGhost(st);
      return;
    }

    this.isTradeActive    = true;
    this.activeTradeAsset = st.symbol;
    this.botState         = 'TRADING';

    const stepInfo = this.config.martingale_enabled
      ? ` | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';

    logTrade(
      `[${bold(cyan(st.symbol))}] 🎯 DIFFER from ${bold(cyan(st.targetDigit))} | ` +
      `Stake: ${bold(green('$' + this.currentStake.toFixed(2)))}${stepInfo} | ` +
      `Rate: ${st.targetRepeatRate.toFixed(1)}% | ` +
      `Score: ${snapScore >= this.config.min_safety_score ? green(snapScore+'/100') : red(snapScore+'/100')} | ` +
      `P(NR): ${(snapPNR*100).toFixed(1)}% | ` +
      `Ghost: ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
    );

    this.sendTelegram(`
      🎯 <b>GHOST TRADE Multi-Bot</b>

      📊 Symbol: ${st.symbol}
      🔢 Target Digit: ${st.targetDigit}
       Last 5 ticks: ${st.tickHistory.slice(-5).join(', ')}
      💰 Stake: $${this.currentStake.toFixed(2)}${stepInfo}
      📈 Repeat Rate: ${st.targetRepeatRate.toFixed(1)}%
      🔬 Score: ${snapScore}/100 | P(NR): ${(snapPNR*100).toFixed(1)}%
      👻 Ghost: ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}
    `.trim());

    this.send({
      buy: 1,
      price: this.currentStake,
      parameters: {
        contract_type: this.config.contract_type,
        symbol:        st.symbol,
        duration:      1,
        duration_unit: 't',
        basis:         'stake',
        amount:        this.currentStake,
        barrier:       String(st.targetDigit),
        currency:      this.config.currency,
      },
    });
  }

  // ── Buy response ───────────────────────────────────────────────────────────
  handleBuy(msg) {
    if (!msg.buy) return;
    this.lastContractId = msg.buy.contract_id;
    this.lastBuyPrice   = parseFloat(msg.buy.buy_price);
    const payout        = parseFloat(msg.buy.payout);
    logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${payout.toFixed(2)}`));
  }

  // ── Transaction (result) ───────────────────────────────────────────────────
  handleTransaction(msg) {
    if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;

    const payout      = parseFloat(msg.transaction.amount) || 0;
    const profit      = payout - this.lastBuyPrice;
    const sym         = this.activeTradeAsset;
    const st          = this.assetStates.get(sym);
    const resultDigit = st && st.tickHistory.length > 0
      ? st.tickHistory[st.tickHistory.length - 1] : null;

    this.totalTrades++;
    if (profit > 0) this.processWin(profit, resultDigit, sym, st);
    else            this.processLoss(this.lastBuyPrice, resultDigit, sym, st);

    this.isTradeActive    = false;
    this.activeTradeAsset = null;
    this.decideNextAction();
  }

  processWin(profit, resultDigit, sym, st) {
    this.totalWins++;
    this.sessionProfit += profit;
    this.currentWinStreak++;
    this.currentLossStreak = 0;
    if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
    if (profit > this.largestWin) this.largestWin = profit;

    if (st) this.assetHMMs.get(sym)?.resetCUSUM(st.targetDigit);

    const recovery = this.martingaleStep > 0 ? green(' 🔄 RECOVERY!') : '';
    const plStr    = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
    logResult(
      `[${bold(cyan(sym))}] ${green('✅ WIN!')} ` +
      `Profit: ${green('+$' + profit.toFixed(2))} | ` +
      `P/L: ${plStr} | ` +
      `Bal: ${green('$' + this.accountBalance.toFixed(2))}` +
      recovery
    );
    if (resultDigit !== null && st)
      logResult(dim(`  Target: ${st.targetDigit} | Result: ${resultDigit} | Ghost: ${st.ghostConsecutiveWins}/${this.config.ghost_wins_required}`));

    this.sendTelegram(`
      ✅ <b>Multi-Bot WIN!</b>

      📊 Symbol: ${sym}
      🎯 Target: ${st ? st.targetDigit : '?'}
       Last 5 ticks: ${st.tickHistory.slice(-5).join(', ')}
      🔢 Result: ${resultDigit !== null ? resultDigit : 'N/A'}
      💰 Profit: +$${profit.toFixed(2)}
      💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
      📊 Balance: $${this.accountBalance.toFixed(2)}
      📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentWinStreak}W
    `.trim());

    this.logSessionLine();
    this.resetMartingale();
    this.resetAllAssetGhosts();
  }

  processLoss(lostAmount, resultDigit, sym, st) {
    this.totalLosses++;
    this.sessionProfit    -= lostAmount;
    this.totalMartingaleLoss += lostAmount;
    this.currentLossStreak++;
    this.currentWinStreak = 0;
    if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
    if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
    this.martingaleStep++;
    if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

    const martInfo = this.config.martingale_enabled ? ` | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
    const plStr    = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
    logResult(
      `[${bold(cyan(sym))}] ${red('❌ LOSS!')} ` +
      `Lost: ${red('-$' + lostAmount.toFixed(2))} | ` +
      `P/L: ${plStr} | ` +
      `Bal: $${this.accountBalance.toFixed(2)}` +
      martInfo
    );
    if (resultDigit !== null && st)
      logResult(dim(`  Target: ${st ? st.targetDigit : '?'} | Result: ${resultDigit} (${resultDigit === (st ? st.targetDigit : -1) ? red('REPEATED') : green('different — unexpected')})`));

    this.sendTelegram(`
      ❌ <b>Multi-Bot LOSS!</b>

      📊 Symbol: ${sym}
      🎯 Target: ${st ? st.targetDigit : '?'}
       Last 5 ticks: ${st.tickHistory.slice(-5).join(', ')}
      🔢 Result: ${resultDigit !== null ? resultDigit : 'N/A'} ${resultDigit === (st ? st.targetDigit : -1) ? red('(REPEATED)') : '(different)'}
      💸 Lost: -$${lostAmount.toFixed(2)}
      💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
      📊 Balance: $${this.accountBalance.toFixed(2)}
      📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentLossStreak}L${martInfo}
    `.trim());

    this.logSessionLine();
    // Reset ALL asset ghost states after a loss
    this.resetAllAssetGhosts();
    this.tradePendingAsset = null;
    logBot(dim('All asset ghost states reset. Fresh analysis for all assets.'));
  }

  resetAllAssetGhosts() {
    this.assetStates.forEach(st => this.resetAssetGhost(st));
  }

  decideNextAction() {
    const risk = this.checkRiskLimits();
    if (!risk.canTrade) {
      logRisk(risk.reason);
      if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
      if (risk.action === 'COOLDOWN') { this.startCooldown();   return; }
    }
    if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
      logRisk(red('🛑 Max Martingale steps reached!'));
      this.resetMartingale();
      this.startCooldown();
      return;
    }
    if (this.config.martingale_enabled && this.martingaleStep > 0) {
      logBot(yellow(`📈 Martingale step ${this.martingaleStep}/${this.config.max_martingale_steps} — next stake: $${this.calculateStake().toFixed(2)}`));
    }
    this.botState = 'ANALYZING';
    logBot(dim('Returning to analysis mode — all assets monitoring...'));
  }

  // ── Regime logging ─────────────────────────────────────────────────────────
  logRegimeAnalysis(st, currentDigit) {
    if (!st.regime || !st.regime.valid) return;
    const r   = st.regime;
    const thr = this.config.repeat_threshold;
    const pct = (r.posteriorNonRep * 100).toFixed(1);

    if (st.signalActive) {
      logAnalysis(
        `[${bold(cyan(st.symbol))}] ${green('✅ SIGNAL')} — digit ${bold(cyan(currentDigit))} | ` +
        `${green(r.hmmStateName)} P(NR):${green(pct+'%')} ` +
        `persist:${green(r.hmmPersistence+'t')} ` +
        `score:${green(r.safetyScore+'/100')} ` +
        `raw:${r.rawRepeatProb[currentDigit].toFixed(0)}% ` +
        `CUSUM:${r.cusumAlarm ? red('⚠️ALARM') : green('OK')}`
      );
    } else {
      // Only log HMM details every 5 ticks to reduce noise
      if (st.tickCount % 5 !== 0) return;
      const reasons = [];
      if (r.hmmState !== 0) reasons.push(`state=${red(r.hmmStateName)}`);
      if (r.posteriorNonRep < this.config.hmm_nonrep_confidence)
        reasons.push(`P(NR)=${red(pct+'%')}<${(this.config.hmm_nonrep_confidence*100).toFixed(0)}%`);
      if (r.hmmPersistence < this.config.min_regime_persistence)
        reasons.push(`persist=${yellow(r.hmmPersistence)}<${this.config.min_regime_persistence}`);
      if (r.rawRepeatProb[currentDigit] >= thr)
        reasons.push(`raw=${red(r.rawRepeatProb[currentDigit].toFixed(0)+'%')}≥${thr}%`);
      if (r.ewmaRepeat[currentDigit] >= thr)
        reasons.push(`EWMA=${red(r.ewmaRepeat[currentDigit].toFixed(0)+'%')}`);
      if (r.cusumAlarm)
        reasons.push(red(`CUSUM⚠️${r.cusumValue.toFixed(2)}`));
      if (r.safetyScore < this.config.min_safety_score)
        reasons.push(`score=${red(r.safetyScore)}<${this.config.min_safety_score}`);
      logHMM(
        `[${bold(st.symbol)}] ${yellow(r.hmmStateName)} ` +
        `P(NR):${pct}% persist:${r.hmmPersistence}t score:${r.safetyScore}/100 | ` +
        `⛔ ${reasons.slice(0,4).join(', ')}`
      );
    }
  }

  logSessionLine() {
    const wr = this.totalTrades > 0
      ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const plStr = this.sessionProfit >= 0
      ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
    logStats(
      `Trades: ${bold(this.totalTrades)} | ` +
      `W: ${green(this.totalWins)} L: ${red(this.totalLosses)} | ` +
      `WR: ${bold(wr+'%')} | ` +
      `P/L: ${plStr} | ` +
      `Bal: ${bold('$'+this.accountBalance.toFixed(2))}`
    );
  }

  // ── Stake calculation ──────────────────────────────────────────────────────
  calculateStake() {
    if (!this.config.martingale_enabled || this.martingaleStep === 0) return this.config.base_stake;
    const raw   = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
    const calc  = Math.round(raw * 100) / 100;
    const final = Math.min(calc, this.config.max_stake);
    logBot(dim(`Mart: Step ${this.martingaleStep} | $${this.config.base_stake.toFixed(2)} × ${this.config.martingale_multiplier}^${this.martingaleStep} = $${final.toFixed(2)}`));
    return final;
  }

  // ── Risk limits ────────────────────────────────────────────────────────────
  checkRiskLimits() {
    if (this.sessionProfit >= this.config.take_profit) {
      this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\nSession end at ${new Date().toLocaleString()}`);
      return { canTrade: false, reason: `🎯 Take profit! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
    }
    if (this.sessionProfit <= -this.config.stop_loss) {
      this.sendTelegram(`🛑 <b>STOP LOSS!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\nSession end at ${new Date().toLocaleString()}`);
      return { canTrade: false, reason: `🛑 Stop loss! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
    }
    const ns = (!this.config.martingale_enabled || this.martingaleStep === 0)
      ? this.config.base_stake
      : Math.min(
          Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep) * 100) / 100,
          this.config.max_stake
        );
    if (ns > this.accountBalance)  return { canTrade: false, reason: `💸 Next stake $${ns.toFixed(2)} > balance $${this.accountBalance.toFixed(2)}`, action: 'STOP' };
    if (ns > this.config.max_stake) return { canTrade: false, reason: `📈 Next stake $${ns.toFixed(2)} > max $${this.config.max_stake}`, action: 'STOP' };
    if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
      return { canTrade: false, reason: '🔄 Max Martingale steps reached.', action: 'COOLDOWN' };
    return { canTrade: true };
  }

  resetMartingale() {
    this.martingaleStep      = 0;
    this.totalMartingaleLoss = 0;
    this.currentStake        = this.config.base_stake;
  }

  startCooldown() {
    this.botState = 'STOPPED'; // temporarily
    this.resetMartingale();
    this.resetAllAssetGhosts();
    this.tradePendingAsset = null;
    const sec = this.config.cooldown_after_max_loss / 1000;
    logBot(yellow(`⏸️  Cooldown for ${sec}s...`));
    this.cooldownTimer = setTimeout(() => {
      if (this.botState === 'STOPPED') {
        logBot(green('▶️  Cooldown ended. Resuming analysis...'));
        this.botState = 'ANALYZING';
      }
    }, this.config.cooldown_after_max_loss);
  }

  // ── Stop ───────────────────────────────────────────────────────────────────
  stop(reason = 'User stopped') {
    this.botState = 'STOPPED';
    logBot(`🛑 ${bold('Stopping bot...')} Reason: ${reason}`);
    if (this.cooldownTimer) { clearTimeout(this.cooldownTimer);  this.cooldownTimer = null; }
    if (this.pingInterval)  { clearInterval(this.pingInterval);  this.pingInterval  = null; }
    this.tradePendingAsset = null;
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
    const wr  = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
    const plC = this.sessionProfit >= 0 ? green : red;
    console.log('');
    logStats(bold(cyan('═══════════════════════════════════════════════════════════')));
    logStats(bold(cyan('          MULTI-ASSET SESSION SUMMARY                      ')));
    logStats(bold(cyan('═══════════════════════════════════════════════════════════')));
    logStats(`  Duration          : ${bold(formatDuration(dur))}`);
    logStats(`  Assets Traded     : ${bold(this.config.active_assets.join(', '))}`);
    logStats(`  Analysis Method   : ${bold('HMM + Bayesian + CUSUM')}`);
    logStats(`  HMM P(NR) Min     : ${bold((this.config.hmm_nonrep_confidence*100).toFixed(0)+'%')}`);
    logStats(`  Min Safety Score  : ${bold(this.config.min_safety_score+'/100')}`);
    logStats(`  Total Trades      : ${bold(this.totalTrades)}`);
    logStats(`  Wins              : ${green(bold(this.totalWins))}`);
    logStats(`  Losses            : ${red(bold(this.totalLosses))}`);
    logStats(`  Win Rate          : ${bold(wr+'%')}`);
    logStats(`  Session P/L       : ${plC(bold(formatMoney(this.sessionProfit)))}`);
    logStats(`  Starting Balance  : $${this.startingBalance.toFixed(2)}`);
    logStats(`  Final Balance     : $${this.accountBalance.toFixed(2)}`);
    logStats(`  Avg P/L per Trade : ${formatMoney(avg)}`);
    logStats(`  Largest Win       : ${green('+$' + this.largestWin.toFixed(2))}`);
    logStats(`  Largest Loss      : ${red('-$' + this.largestLoss.toFixed(2))}`);
    logStats(`  Max Win Streak    : ${green(bold(this.maxWinStreak))}`);
    logStats(`  Max Loss Streak   : ${red(bold(this.maxLossStreak))}`);
    logStats(`  Max Mart. Step    : Step ${this.maxMartingaleReached}`);
    logStats(bold(cyan('═══════════════════════════════════════════════════════════')));
    console.log('');
  }
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
  const config = parseArgs();
  const bot    = new RomanianGhostBot(config);

  process.on('SIGINT',  () => { console.log(''); bot.stop('SIGINT (Ctrl+C)'); });
  process.on('SIGTERM', () => { bot.stop('SIGTERM'); });
  process.on('uncaughtException', e => {
    logError(`Uncaught exception: ${e.message}`);
    if (e.stack) console.error(e.stack);
    bot.stop('Uncaught exception');
  });
  process.on('unhandledRejection', reason => {
    logError(`Unhandled rejection: ${reason}`);
  });

  bot.start();
})();
