'use strict';
/**
 * HiLo-Fast — time-block paired Deriv contracts (stay-in-range, EV-first)
 * Single-file NodeJS port. Run with: node hilo-fast-bot.js [flags]
 *
 * Dependencies: npm install ws
 * Node version: 18+ (uses native fetch, AbortController)
 */

// ─── Imports ────────────────────────────────────────────────────────────────────
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { dirname } = require('path');

// ─── .env loader (Node doesn't auto-load like Bun) ──────────────────────────────
(function() {
  try {
    const p = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(p)) return;
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      const hashIdx = value.indexOf('#');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) { /* ignore malformed .env */ }
})();

// ─── Constants ──────────────────────────────────────────────────────────────────
const DERIV_REST_BASE = 'https://api.derivws.com/trading/v1/options';
const DEFAULT_APP_ID = '331jnczBJfg53USa1NUZm';
const PING_INTERVAL_MS = 30000;
const SESSION_ROLLOVER_MS = 50 * 60 * 1000; // 50 minutes
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const DEFAULT_TRAIL_ARM_FRACTION = 0.5;

const ALLOWED_CANDLE_GRANULARITIES = new Set([
  60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
]);

// ─── CONFIG (defaults) ──────────────────────────────────────────────────────────
const CONFIG = {
  // Auth / transport
  APP_ID: process.env.DERIV_APP_ID || DEFAULT_APP_ID,
  TOKEN: process.env.DERIV_TOKEN || '',
  ACCOUNT_ID: process.env.DERIV_ACCOUNT_ID || undefined,
  PREFER: process.env.HILO_PREFER || 'demo',

  // Market
  SYMBOL: process.env.HILO_SYMBOL || '1HZ100V',
  CURRENCY: process.env.HILO_CURRENCY || '',
  STAKE: Number(process.env.HILO_STAKE) || 1.0,

  // Block grid
  BLOCK_MINUTES: Number(process.env.HILO_BLOCK_MINUTES) || 3,
  BLOCK_TP: Number(process.env.HILO_BLOCK_TP) || 1.5,
  BLOCK_SL: Number(process.env.HILO_BLOCK_SL) || 0,
  BLOCK_TRAIL: Number(process.env.HILO_BLOCK_TRAIL) || 0.5,
  SESSION_TP: Number(process.env.HILO_SESSION_TP) || 15,
  SESSION_SL: Number(process.env.HILO_SESSION_SL) || 10,

  // Trade primitive
  MODE: (function() {
    const raw = (process.env.HILO_TRADE_MODE || 'no-touch').toLowerCase();
    if (raw === 'hl' || raw === 'higherlower' || raw === 'higher-lower') return 'higher-lower';
    return 'no-touch';
  })(),

  // Prediction
  RANGE_MODE: (function() {
    const raw = (process.env.HILO_RANGE_MODE || 'hybrid').toLowerCase();
    if (raw === 'h' || raw === 'hybrid') return 'hybrid';
    if (raw === 'hist' || raw === 'historical') return 'historical';
    if (raw === 'atr') return 'atr';
    return 'hybrid';
  })(),
  LOOKBACK_DAYS: Number(process.env.HILO_LOOKBACK_DAYS) || 20,
  ATR_BARS: Number(process.env.HILO_ATR_BARS) || 14,
  RANGE_K: Number(process.env.HILO_RANGE_K) || 1.0,
  REGIME_BARS: Number(process.env.HILO_REGIME_BARS) || 24,
  REGIME_BLEND: Number(process.env.HILO_REGIME_BLEND) || 0,

  // EV-first band selection (Phase 1)
  EV_MODE: process.env.HILO_EV_MODE === '1' || process.env.HILO_EV_MODE === 'true',
  K_CANDIDATES: (function() {
    const raw = process.env.HILO_K_CANDIDATES;
    if (!raw) return [1.0, 1.5, 2.0, 2.5, 3.0];
    const out = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    return out.length ? out : [1.0, 1.5, 2.0, 2.5, 3.0];
  })(),
  MIN_EV: Number(process.env.HILO_MIN_EV) || 0.15,
  DRY_RUN_EDGE: Number(process.env.HILO_DRY_RUN_EDGE) || 0.03,
  EV_STAGGER: process.env.HILO_EV_STAGGER === '1' || process.env.HILO_EV_STAGGER === 'true',

  // Trade direction & Martingale
  TRADE_DIRECTION: (function() {
    const raw = (process.env.HILO_TRADE_DIRECTION || 'both').toLowerCase();
    if (raw === 'positive-ev' || raw === 'positiveev' || raw === 'positive' || raw === 'single') return 'positive-ev';
    return 'both';
  })(),
  MARTINGALE_ENABLED: process.env.HILO_MARTINGALE_ENABLED === '1' || process.env.HILO_MARTINGALE_ENABLED === 'true',
  MARTINGALE_MULTIPLIER: Number(process.env.HILO_MARTINGALE_MULTIPLIER) || 2,
  MARTINGALE_STEPS: Number(process.env.HILO_MARTINGALE_STEPS) || 3,

  // Survival & measurement (Phase 3)
  LEDGER_PATH: process.env.HILO_LEDGER || '',
  STATE_PATH: process.env.HILO_STATE_PATH || '.hilo_state_01.json',
  MAX_CONSECUTIVE_LOSSES: Number(process.env.HILO_MAX_LOSSES) || 25,
  DAILY_LOSS_CAP: Number(process.env.HILO_DAILY_LOSS_CAP) || 200,

  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // Modes
  DRY_RUN: false,
  SKIP_CONTRACT_CHECK: false,
  NO_UI: true,
  DEBUG_MODE: false,
};

// Dedupe and sort K candidates
CONFIG.K_CANDIDATES = [...new Set(CONFIG.K_CANDIDATES)].sort((a, b) => a - b);

// Stake guard: enforce minimum and warn about stagger + low base.
const STAKE_MIN_DERIV = 0.35;
const STAKE_MIN_STAGGER = 0.70;
if (CONFIG.STAKE < STAKE_MIN_DERIV) {
  CONFIG.STAKE = STAKE_MIN_DERIV;
}
if (CONFIG.EV_STAGGER && CONFIG.STAKE < STAKE_MIN_STAGGER) {
  // When base < 0.70, stagger's 0.5× floor clips at 0.35 defeating differentiation.
  // Auto-disable stagger unless the user explicitly set HILO_ALLOW_MICRO_STAGGER.
  if (process.env.HILO_ALLOW_MICRO_STAGGER !== '1' && process.env.HILO_ALLOW_MICRO_STAGGER !== 'true') {
    CONFIG.EV_STAGGER = false;
    // Will log warning after LOGGER is defined
  }
}
const _staggerWarn = CONFIG.EV_STAGGER === false && (process.env.HILO_EV_STAGGER === '1' || process.env.HILO_EV_STAGGER === 'true') && CONFIG.STAKE < STAKE_MIN_STAGGER;

// ─── LOGGER ─────────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const LOGGER = {
  info:   (msg) => console.log(`\x1b[36m[INFO]  ${timestamp()} - ${msg}\x1b[0m`),
  trade:  (msg) => console.log(`\x1b[32m[TRADE] ${timestamp()} - ${msg}\x1b[0m`),
  block:  (msg) => console.log(`\x1b[95m[BLOCK] ${timestamp()} - ${msg}\x1b[0m`),
  sell:   (msg) => console.log(`\x1b[95m[SELL]  ${timestamp()} - ${msg}\x1b[0m`),
  warn:   (msg) => console.warn(`\x1b[33m[WARN]  ${timestamp()} - ${msg}\x1b[0m`),
  error:  (msg) => console.error(`\x1b[31m[ERROR] ${timestamp()} - ${msg}\x1b[0m`),
  debug:  (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${timestamp()} - ${msg}\x1b[0m`); },
  system: (msg) => console.log(`\x1b[34m[SYS]   ${timestamp()} - ${msg}\x1b[0m`),
};

// Deferred stagger warning (needs LOGGER).
if (_staggerWarn) {
  LOGGER.warn('EV_STAGGER auto-disabled: stake $' + CONFIG.STAKE.toFixed(2) + ' < $0.70 — stagger 0.5× would clip at $0.35, defeating edge sizing. Set HILO_ALLOW_MICRO_STAGGER=1 or raise --stake to 0.70+ to re-enable.');
}

// ─── Utility Functions ──────────────────────────────────────────────────────────
function timeHM(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(11, 16);
}

function fmtPct(p) {
  return (p * 100).toFixed(1) + '%';
}

function fmtSigned(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function utcDayKey(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function blockSeconds() {
  return CONFIG.BLOCK_MINUTES * 60;
}

function contractTypeFor(mode, side) {
  if (mode === 'no-touch') return 'NOTOUCH';
  return side === 'HIGHER' ? 'LOWER' : 'HIGHER';
}

function legDisplayName(mode, side) {
  const ct = contractTypeFor(mode, side);
  return side === 'HIGHER' ? `${ct}↑` : `${ct}↓`;
}

function formatBarrier(price, pipDigits) {
  return price.toFixed(pipDigits);
}

function toNum(x) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  const n = typeof x === 'string' ? Number(x) : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function assertBlockGranularity(blockMinutes) {
  const sec = blockMinutes * 60;
  if (!ALLOWED_CANDLE_GRANULARITIES.has(sec)) {
    throw new Error(
      `block of ${blockMinutes} min = ${sec}s is not a Deriv candle granularity. ` +
      `Allowed blocks (min): 1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440.`
    );
  }
}

// ─── parseArgs() ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const HELP_TEXT = `
HiLo-Fast — time-block paired Deriv contracts (stay-in-range, EV-first)

Usage:
  node hilo-fast-bot.js [flags]

Required:
  --token <t>               Deriv API / OAuth token (or env DERIV_TOKEN)

Market:
  --symbol <sym>            underlying symbol (default ${CONFIG.SYMBOL})
  --stake <usd>             per-leg stake (default ${CONFIG.STAKE})
  --currency <c>            currency override (default: account currency)

Block grid:
  --block-minutes <n>       block size in minutes (default ${CONFIG.BLOCK_MINUTES})
  --block-tp <usd>          sell pair when combined live P/L >= this (default ${CONFIG.BLOCK_TP})
  --block-sl <usd>          sell pair when combined live P/L <= -this (default ${CONFIG.BLOCK_SL || 'off'})
  --block-trail <usd>       sell pair when P/L retraces this far below its intrabar peak (default ${CONFIG.BLOCK_TRAIL || 'off'})
  --session-tp <usd>        halt when session P/L >= this (default ${CONFIG.SESSION_TP})
  --session-sl <usd>        halt when session P/L <= -this (default ${CONFIG.SESSION_SL})

Trade primitive:
  --mode <hl|nt>            higher-lower or no-touch (default ${CONFIG.MODE})

Prediction:
  --range-mode <m>          hybrid | historical | atr (default ${CONFIG.RANGE_MODE})
  --lookback-days <n>       same-TOD lookback (default ${CONFIG.LOOKBACK_DAYS})
  --atr-bars <n>            ATR window for fallback (default ${CONFIG.ATR_BARS})
  --range-k <x>             extension multiplier (default ${CONFIG.RANGE_K})
  --regime-bars <n>         recent-vol window (default ${CONFIG.REGIME_BARS})
  --regime-blend <x>        0=off, 1=recent only (default ${CONFIG.REGIME_BLEND})

EV-first band selection (ON by default):
  --ev-mode / --no-ev-mode  EV-first band selection (default on)
  --k-candidates <a,b,...>  K grid (default ${CONFIG.K_CANDIDATES.join(',')})
  --min-ev <usd>            min combined block EV (default ${CONFIG.MIN_EV})
  --dry-run-edge <x>        simulated house vol premium (default ${CONFIG.DRY_RUN_EDGE})
  --ev-stagger / --no-ev-stagger  edge-scaled stake (default on)

Trade direction:
  --trade-direction <mode>  both or positive-ev (default ${CONFIG.TRADE_DIRECTION})

Martingale (OFF by default):
  --martingale / --no-martingale  enable/disable (default off)
  --martingale-multiplier <x>     stake multiplier per step (default ${CONFIG.MARTINGALE_MULTIPLIER})
  --martingale-steps <n>          max steps before reset (default ${CONFIG.MARTINGALE_STEPS})

Survival:
  --ledger <path>           CSV ledger path (default off)
  --max-losses <n>          halt after n consecutive losses (default ${CONFIG.MAX_CONSECUTIVE_LOSSES})
  --daily-loss-cap <usd>    halt when today's P/L <= -this (default ${CONFIG.DAILY_LOSS_CAP})

Telegram (both required):
  --telegram-token <t>      bot token (or env TELEGRAM_BOT_TOKEN)
  --telegram-chat-id <id>   chat ID (or env TELEGRAM_CHAT_ID)

State:
  --state-path <path>       JSON state file (default ${CONFIG.STATE_PATH})

Account:
  --account-id <id>         pin to a specific account
  --prefer <demo|real>      prefer demo or real (default ${CONFIG.PREFER})

Modes:
  --dry-run                 synthetic candles, no network trades
  --skip-contract-check     skip contracts_for verification
  --app-id <id>             Deriv app id (default ${CONFIG.APP_ID})
  --debug                   enable debug logging

Misc:
  --help / -h               this message
  --version / -v            print version
`;

  function err(msg) {
    process.stderr.write(`hilo-fast: ${msg}\n\n${HELP_TEXT.trim()}\n`);
    process.exit(2);
  }

  function numArg(v, name) {
    if (v === undefined) err(`--${name} requires a value`);
    const n = Number(v);
    if (!Number.isFinite(n)) err(`--${name} must be a number (got '${v}')`);
    return n;
  }

  function str(v, name) {
    if (v === undefined || v === '') err(`--${name} requires a value`);
    return v;
  }

  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nxt = argv[i + 1];
    switch (a) {
      case '--help': case '-h': help = true; break;
      case '--version': case '-v': version = true; break;
      case '--token': CONFIG.TOKEN = str(nxt, 'token'); i++; break;
      case '--app-id': CONFIG.APP_ID = str(nxt, 'app-id'); i++; break;
      case '--account-id': CONFIG.ACCOUNT_ID = str(nxt, 'account-id'); i++; break;
      case '--prefer': {
        const v = str(nxt, 'prefer').toLowerCase();
        if (v !== 'demo' && v !== 'real') err(`--prefer must be 'demo' or 'real'`);
        CONFIG.PREFER = v; i++; break;
      }
      case '--symbol': CONFIG.SYMBOL = str(nxt, 'symbol'); i++; break;
      case '--currency': CONFIG.CURRENCY = str(nxt, 'currency'); i++; break;
      case '--stake': CONFIG.STAKE = numArg(nxt, 'stake'); i++; break;
      case '--block-minutes': CONFIG.BLOCK_MINUTES = numArg(nxt, 'block-minutes'); i++; break;
      case '--mode': {
        const v = str(nxt, 'mode').toLowerCase();
        if (v === 'higher-lower' || v === 'hl' || v === 'higherlower') CONFIG.MODE = 'higher-lower';
        else if (v === 'no-touch' || v === 'nt' || v === 'notouch') CONFIG.MODE = 'no-touch';
        else err(`--mode must be: higher-lower, no-touch (got '${v}')`);
        i++; break;
      }
      case '--block-tp': CONFIG.BLOCK_TP = numArg(nxt, 'block-tp'); i++; break;
      case '--block-sl': CONFIG.BLOCK_SL = numArg(nxt, 'block-sl'); i++; break;
      case '--block-trail': CONFIG.BLOCK_TRAIL = numArg(nxt, 'block-trail'); i++; break;
      case '--session-tp': CONFIG.SESSION_TP = numArg(nxt, 'session-tp'); i++; break;
      case '--session-sl': CONFIG.SESSION_SL = numArg(nxt, 'session-sl'); i++; break;
      case '--range-mode': {
        const v = str(nxt, 'range-mode').toLowerCase();
        if (v === 'h' || v === 'hybrid') CONFIG.RANGE_MODE = 'hybrid';
        else if (v === 'hist' || v === 'historical') CONFIG.RANGE_MODE = 'historical';
        else if (v === 'atr') CONFIG.RANGE_MODE = 'atr';
        else err(`--range-mode must be: hybrid, historical, atr (got '${v}')`);
        i++; break;
      }
      case '--lookback-days': CONFIG.LOOKBACK_DAYS = numArg(nxt, 'lookback-days'); i++; break;
      case '--atr-bars': CONFIG.ATR_BARS = numArg(nxt, 'atr-bars'); i++; break;
      case '--range-k': CONFIG.RANGE_K = numArg(nxt, 'range-k'); i++; break;
      case '--regime-bars': CONFIG.REGIME_BARS = numArg(nxt, 'regime-bars'); i++; break;
      case '--regime-blend': CONFIG.REGIME_BLEND = numArg(nxt, 'regime-blend'); i++; break;
      case '--ev-mode': CONFIG.EV_MODE = true; break;
      case '--k-candidates': {
        const v = str(nxt, 'k-candidates');
        const out = v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
        if (out.length === 0) err(`--k-candidates: '${v}' has no positive numbers`);
        CONFIG.K_CANDIDATES = [...new Set(out)].sort((a, b) => a - b);
        i++; break;
      }
      case '--min-ev': CONFIG.MIN_EV = numArg(nxt, 'min-ev'); i++; break;
      case '--dry-run-edge': CONFIG.DRY_RUN_EDGE = numArg(nxt, 'dry-run-edge'); i++; break;
      case '--ev-stagger': CONFIG.EV_STAGGER = true; break;
      case '--trade-direction': {
        const v = str(nxt, 'trade-direction').toLowerCase();
        if (v === 'both') CONFIG.TRADE_DIRECTION = 'both';
        else if (v === 'positive-ev' || v === 'positiveev' || v === 'positive' || v === 'single') CONFIG.TRADE_DIRECTION = 'positive-ev';
        else err(`--trade-direction must be: both, positive-ev (got '${v}')`);
        i++; break;
      }
      case '--martingale': CONFIG.MARTINGALE_ENABLED = true; break;
      case '--martingale-multiplier': CONFIG.MARTINGALE_MULTIPLIER = numArg(nxt, 'martingale-multiplier'); i++; break;
      case '--martingale-steps': CONFIG.MARTINGALE_STEPS = numArg(nxt, 'martingale-steps'); i++; break;
      case '--ledger': CONFIG.LEDGER_PATH = str(nxt, 'ledger'); i++; break;
      case '--max-losses': CONFIG.MAX_CONSECUTIVE_LOSSES = numArg(nxt, 'max-losses'); i++; break;
      case '--daily-loss-cap': CONFIG.DAILY_LOSS_CAP = numArg(nxt, 'daily-loss-cap'); i++; break;
      case '--telegram-token': CONFIG.TELEGRAM_TOKEN = str(nxt, 'telegram-token'); i++; break;
      case '--telegram-chat-id': CONFIG.TELEGRAM_CHAT_ID = str(nxt, 'telegram-chat-id'); i++; break;
      case '--state-path': CONFIG.STATE_PATH = str(nxt, 'state-path'); i++; break;
      case '--dry-run': CONFIG.DRY_RUN = true; break;
      case '--skip-contract-check': CONFIG.SKIP_CONTRACT_CHECK = true; break;
      case '--debug': CONFIG.DEBUG_MODE = true; break;
      default:
        if (a.startsWith('--no-')) break;
        if (a.startsWith('-')) err(`unknown flag: ${a}`);
        err(`unexpected positional argument: ${a}`);
    }
  }

  // Negating flags
  if (argv.includes('--no-ev-mode')) CONFIG.EV_MODE = false;
  if (argv.includes('--no-ev-stagger')) CONFIG.EV_STAGGER = false;
  if (argv.includes('--no-martingale')) CONFIG.MARTINGALE_ENABLED = false;

  // Validation
  if (!Number.isInteger(CONFIG.BLOCK_MINUTES) || CONFIG.BLOCK_MINUTES <= 0) {
    err(`--block-minutes must be a positive integer (got '${CONFIG.BLOCK_MINUTES}')`);
  }
  assertBlockGranularity(CONFIG.BLOCK_MINUTES);

  if (CONFIG.REGIME_BARS !== undefined && (!Number.isInteger(CONFIG.REGIME_BARS) || CONFIG.REGIME_BARS <= 0)) {
    err(`--regime-bars must be a positive integer (got '${CONFIG.REGIME_BARS}')`);
  }
  if (CONFIG.REGIME_BLEND !== undefined && (CONFIG.REGIME_BLEND < 0 || CONFIG.REGIME_BLEND > 1)) {
    err(`--regime-blend must be between 0 and 1 (got '${CONFIG.REGIME_BLEND}')`);
  }

  return { help, version };
}

// ─── Pure Math Functions ────────────────────────────────────────────────────────

/**
 * Standard-normal CDF via A&S 7.1.26 (|err| ≈ 1.5e-7).
 */
function normCdf(z) {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const inner = (((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - t * inner * Math.exp(-x * x);
  return 0.5 * (1 + Math.sign(z) * erf);
}

/**
 * Win probability of a stay-in-range leg whose barrier sits z block
 * volatilities away from the anchor.
 */
function winRateFromZ(z, mode) {
  return mode === 'no-touch' ? 2 * normCdf(z) - 1 : normCdf(z);
}

/**
 * Build a win-rate model from same-TOD mean excursions.
 * σ is calibrated from E[max] = σ·√(2T/π) → σ = mean / √(2T/π).
 */
function winRateModelFromMeans(meanUp, meanDn, blockSec, daysUsed) {
  const ticks = Math.max(1, blockSec);
  return {
    meanUp,
    meanDn,
    sigmaUp: meanUp / Math.sqrt((2 * ticks) / Math.PI),
    sigmaDn: meanDn / Math.sqrt((2 * ticks) / Math.PI),
    ticks,
    daysUsed,
  };
}

/**
 * Per-side block volatility σ·√T, the natural distance unit for win rates.
 */
function legSigmaBlock(model, side) {
  const sigma = side === 'HIGHER' ? model.sigmaUp : model.sigmaDn;
  return sigma * Math.sqrt(model.ticks);
}

/**
 * True win probability for a leg at a given distance.
 */
function winRate(model, mode, side, distance) {
  return winRateFromZ(distance / legSigmaBlock(model, side), mode);
}

/**
 * Floor an epoch-seconds timestamp to the UTC midnight of its day.
 */
function dayStart(epochSec) {
  return Math.floor(epochSec / 86400) * 86400;
}

// ─── Regime Detection ───────────────────────────────────────────────────────────

const REGIME_RATIO_MIN = 0.25;
const REGIME_RATIO_MAX = 4;

/**
 * Mean up/dn block excursion over the last N completed block-windows.
 */
function recentExcursions(candles, blockStart, blockEnd, bars) {
  if (!(blockEnd > blockStart)) return null;
  const blockSec = blockEnd - blockStart;
  const windows = Math.floor(bars);
  if (!(windows >= 1)) return null;

  let sumUp = 0, sumDn = 0, count = 0;
  for (let w = 1; w <= windows; w++) {
    const wStart = blockStart - w * blockSec;
    const wEnd = wStart + blockSec;
    let o = Number.NaN, hi = -Infinity, lo = Infinity, found = false;
    for (const c of candles) {
      if (c.epoch >= wEnd) break;
      if (c.epoch < wStart) continue;
      if (!found) { o = c.open; hi = c.high; lo = c.low; found = true; }
      else { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
    }
    if (found) { sumUp += hi - o; sumDn += o - lo; count++; }
  }
  if (count === 0) return null;
  return { up: sumUp / count, dn: sumDn / count, count };
}

/**
 * Blend same-TOD means toward recent realized vol.
 */
function blendMeans(sameTodUp, sameTodDn, recent, blend) {
  const b = Math.min(1, Math.max(0, blend));
  const side = (sameTod, recentVal) => {
    if (!(sameTod > 0) || !(recentVal > 0)) return { mean: sameTod, ratio: 1 };
    const ratio = Math.min(REGIME_RATIO_MAX, Math.max(REGIME_RATIO_MIN, recentVal / sameTod));
    return { mean: sameTod + b * (recentVal - sameTod), ratio };
  };
  const up = side(sameTodUp, recent.up);
  const dn = side(sameTodDn, recent.dn);
  return { meanUp: up.mean, meanDn: dn.mean, ratioUp: up.ratio, ratioDn: dn.ratio };
}

/**
 * RegimeParams from config, or undefined when blend ≤ 0.
 */
function regimeFromConfig(cfg) {
  const blend = cfg.regimeBlend ?? 0;
  if (!(blend > 0)) return undefined;
  const bars = Math.floor(cfg.regimeBars ?? 0);
  return bars > 0 ? { bars, blend } : undefined;
}

// ─── Exit Logic ─────────────────────────────────────────────────────────────────

function newExitState() {
  return { peakPL: 0, trailArmed: false };
}

/**
 * Decide whether to exit the pair now. Updates state in place.
 * Precedence: TP, then SL, then trail.
 */
function evaluatePairExit(args) {
  const { state, profit } = args;
  if (profit > state.peakPL) state.peakPL = profit;
  if (!state.trailArmed && args.trailArmAt > 0 && state.peakPL >= args.trailArmAt) {
    state.trailArmed = true;
  }
  if (args.blockTp > 0 && profit >= args.blockTp) return { exit: true, reason: 'tp' };
  if (args.blockSl > 0 && profit <= -args.blockSl) return { exit: true, reason: 'sl' };
  if (args.blockTrail > 0 && state.trailArmed && state.peakPL - profit >= args.blockTrail) {
    return { exit: true, reason: 'trail' };
  }
  return { exit: false };
}

/**
 * Edge-scaled per-leg stake: baseStake × clamp(1 + α·edge, minRatio, maxRatio).
 * Enforces Deriv's minimum stake ($0.35) to prevent buy rejections.
 * Returns { stake, ratio, clipped } so callers can detect when the floor
 * defeated the intended downsize (clipped && ratio < 1).
 */
function staggerStake(args) {
  const { baseStake, edge } = args;
  const alpha = args.alpha ?? 2;
  const minRatio = args.minRatio ?? 0.5;
  const maxRatio = args.maxRatio ?? 2;
  const ratio = Math.min(maxRatio, Math.max(minRatio, 1 + alpha * edge));
  // Deriv minimum stake is $0.35 — below this the buy is rejected.
  const minStake = 0.35;
  const rawStake = Math.round(baseStake * ratio * 100) / 100;
  const stake = Math.max(minStake, rawStake);
  const clipped = rawStake < minStake;
  return { stake, ratio, clipped };
}

/**
 * Ensure barriers always straddle spot with a minimum distance.
 * When meanUp/meanDn is near zero (flat history), one barrier could sit
 * at or beyond spot, making the bet meaningless or causing Deriv to reject
 * the proposal. This enforces a per-side minimum distance (half the
 * calibrated sigma) plus a dynamic pip floor scaled to the instrument.
 *
 * @returns { predHigh, predLow, adjusted } — adjusted is true when any
 *   distance was raised above the raw K·mean value.
 */
function enforceBarrierFloor(spot, predHigh, predLow, model, pipDigits) {
  const pipSize = pipDigits <= 2 ? 0.01 : pipDigits <= 4 ? 0.0001 : Math.pow(10, -pipDigits);
  const pipFloor = Math.max(0.05, 5 * pipSize);

  const rawDistUp = predHigh - spot;
  const rawDistDn = spot - predLow;

  const sigmaUp = model ? (model.sigmaUp * Math.sqrt(model.ticks)) : 0;
  const sigmaDn = model ? (model.sigmaDn * Math.sqrt(model.ticks)) : 0;

  const minDistUp = Math.max(sigmaUp > 0 ? sigmaUp * 0.5 : 0.01, pipFloor);
  const minDistDn = Math.max(sigmaDn > 0 ? sigmaDn * 0.5 : 0.01, pipFloor);

  const safeDistUp = Math.max(rawDistUp, minDistUp);
  const safeDistDn = Math.max(rawDistDn, minDistDn);

  return {
    predHigh: spot + safeDistUp,
    predLow: spot - safeDistDn,
    adjusted: safeDistUp > rawDistUp || safeDistDn > rawDistDn,
  };
}

/**
 * Check if a Deriv error message indicates a transient/retryable failure.
 */
function isRetryableError(msg) {
  return msg.indexOf('PriceMoved') !== -1
    || msg.indexOf('price') !== -1
    || msg.indexOf('RateLimit') !== -1
    || msg.indexOf('rate limit') !== -1
    || msg.indexOf('busy') !== -1
    || msg.indexOf('timeout') !== -1
    || msg.indexOf('Timeout') !== -1
    || msg.indexOf('NetworkError') !== -1
    || msg.indexOf('ConnectionClosed') !== -1;
}

/**
 * P(win now) for an open leg at current distance and remaining time.
 */
function currentWinProb(args) {
  const { distance, sigmaPerTick, mode } = args;
  const rem = Math.max(1, args.secondsRemaining);
  if (!(sigmaPerTick > 0)) return 0.5;
  return winRateFromZ(distance / (sigmaPerTick * Math.sqrt(rem)), mode);
}

/**
 * Mark-to-market P/L of a single leg given its current win probability.
 */
function markToMarketProfit(args) {
  const { payout, stake, currentWinP } = args;
  return (payout - stake) * currentWinP - stake * (1 - currentWinP);
}

// ─── Dry-Run Pricing ────────────────────────────────────────────────────────────

function clampP(p) {
  return Math.min(0.995, Math.max(0.02, p));
}

/**
 * Simulate a Deriv quote for dry-run. The house prices from our σ scaled by (1+edge).
 */
function simulateQuote(args) {
  const { distance, sigmaBlock, mode, edge, stake } = args;
  if (!(sigmaBlock > 0) || !(distance > 0)) {
    return { payout: stake * 2, impliedP: 0.5 };
  }
  const z = distance / sigmaBlock;
  const zHouse = z / (1 + edge);
  const impliedP = clampP(winRateFromZ(zHouse, mode));
  return { impliedP, payout: stake / impliedP };
}

// ─── Range Prediction ───────────────────────────────────────────────────────────

/**
 * Same-TOD excursion statistics over the last N days.
 */
function estimateWinRates(candles, blockStart, blockEnd, lookbackDays, regime) {
  const blockSec = blockEnd - blockStart;
  if (blockSec <= 0 || lookbackDays <= 0) return null;

  const todStart = blockStart - dayStart(blockStart);
  const todEnd = blockEnd - dayStart(blockStart);
  const anchorDay = dayStart(blockStart);

  let sumUp = 0, sumDn = 0, daysUsed = 0;
  for (let d = 1; d <= lookbackDays; d++) {
    const histDay = anchorDay - d * 86400;
    const hStart = histDay + todStart;
    const hEnd = histDay + todEnd;

    let hOpen = Number.NaN, hHigh = -Infinity, hLow = Infinity, found = false;
    for (const c of candles) {
      if (c.epoch >= hEnd) break;
      if (c.epoch < hStart) continue;
      if (!found) { hOpen = c.open; hHigh = c.high; hLow = c.low; found = true; }
      else { if (c.high > hHigh) hHigh = c.high; if (c.low < hLow) hLow = c.low; }
    }
    if (found) { sumUp += hHigh - hOpen; sumDn += hOpen - hLow; daysUsed++; }
  }
  if (daysUsed === 0) return null;
  let meanUp = sumUp / daysUsed;
  let meanDn = sumDn / daysUsed;
  if (regime && regime.blend > 0) {
    const recent = recentExcursions(candles, blockStart, blockEnd, regime.bars);
    if (recent) {
      const blended = blendMeans(meanUp, meanDn, recent, regime.blend);
      meanUp = blended.meanUp;
      meanDn = blended.meanDn;
    }
  }
  return winRateModelFromMeans(meanUp, meanDn, blockSec, daysUsed);
}

/**
 * Non-repainting block high/low prediction.
 */
function predictRange(candles, blockStart, blockEnd, spot, cfg) {
  const blockSec = blockEnd - blockStart;
  if (blockSec <= 0) return null;

  let blockOpen = Number.NaN;
  for (const c of candles) {
    if (c.epoch < blockStart) continue;
    if (c.epoch >= blockEnd) break;
    blockOpen = c.open;
    break;
  }
  if (!Number.isFinite(blockOpen)) {
    if (!Number.isFinite(spot) || spot <= 0) return null;
    blockOpen = spot;
  }

  const todStart = blockStart - dayStart(blockStart);
  const todEnd = blockEnd - dayStart(blockStart);
  let sumUp = 0, sumDn = 0, daysUsed = 0;

  if (cfg.mode !== 'atr' && cfg.lookbackDays > 0) {
    const anchorDay = dayStart(blockStart);
    for (let d = 1; d <= cfg.lookbackDays; d++) {
      const histDay = anchorDay - d * 86400;
      const hStart = histDay + todStart;
      const hEnd = histDay + todEnd;

      let hOpen = Number.NaN, hHigh = -Infinity, hLow = Infinity, found = false;
      for (const c of candles) {
        if (c.epoch >= hEnd) break;
        if (c.epoch < hStart) continue;
        if (!found) { hOpen = c.open; hHigh = c.high; hLow = c.low; found = true; }
        else { if (c.high > hHigh) hHigh = c.high; if (c.low < hLow) hLow = c.low; }
      }
      if (found) { sumUp += hHigh - hOpen; sumDn += hOpen - hLow; daysUsed++; }
    }
  }

  if (daysUsed > 0) {
    const meanUp = sumUp / daysUsed;
    const meanDn = sumDn / daysUsed;
    const reg = cfg.regime;
    if (reg && reg.blend > 0) {
      const recent = recentExcursions(candles, blockStart, blockEnd, reg.bars);
      if (recent) {
        const blended = blendMeans(meanUp, meanDn, recent, reg.blend);
        return {
          blockOpen,
          predictedHigh: blockOpen + cfg.k * blended.meanUp,
          predictedLow: blockOpen - cfg.k * blended.meanDn,
          source: 'historical',
          daysUsed,
          meanUp: blended.meanUp,
          meanDown: blended.meanDn,
        };
      }
    }
    return {
      blockOpen,
      predictedHigh: blockOpen + cfg.k * meanUp,
      predictedLow: blockOpen - cfg.k * meanDn,
      source: 'historical',
      daysUsed,
      meanUp,
      meanDown: meanDn,
    };
  }

  if (cfg.mode === 'historical') return null;

  // ATR fallback
  const past = candles.filter(c => c.epoch < blockStart);
  if (past.length < cfg.atrBars + 1) return null;

  let sumTr = 0;
  const start = past.length - cfg.atrBars;
  for (let i = start; i < past.length; i++) {
    const cur = past[i];
    const prev = past[i - 1];
    const hl = cur.high - cur.low;
    const hpc = Math.abs(cur.high - prev.close);
    const lpc = Math.abs(cur.low - prev.close);
    sumTr += Math.max(hl, Math.max(hpc, lpc));
  }
  const atr = sumTr / cfg.atrBars;
  if (!(atr > 0)) return null;

  const barsPerBlock = blockSec / cfg.granularitySec;
  if (!(barsPerBlock > 0)) return null;

  const ext = 0.5 * atr * Math.sqrt(barsPerBlock) * cfg.k;
  return {
    blockOpen,
    predictedHigh: blockOpen + ext,
    predictedLow: blockOpen - ext,
    source: 'atr',
    daysUsed: 0,
    atr,
  };
}

/**
 * Quote every candidate K (both legs), compute combined EV, return the best band.
 */
async function selectBand(args) {
  const { candles, blockStart, blockEnd, spot, mode, kCandidates, minEv, lookbackDays, quote } = args;
  const model = estimateWinRates(candles, blockStart, blockEnd, lookbackDays, args.regime);
  if (!model) return null;

  const durationSec = args.durationSec ?? Math.max(15, Math.floor(blockEnd - Date.now() / 1000));
  const candidates = [];

  for (const k of kCandidates) {
    const rawPredHigh = spot + k * model.meanUp;
    const rawPredLow = spot - k * model.meanDn;
    const floored = enforceBarrierFloor(spot, rawPredHigh, rawPredLow, model, 2);
    const predHigh = floored.predHigh;
    const predLow = floored.predLow;
    const safeDistUp = predHigh - spot;
    const safeDistDn = spot - predLow;
    const truePUp = winRate(model, mode, 'HIGHER', safeDistUp);
    const truePDn = winRate(model, mode, 'LOWER', safeDistDn);

    const [qUp, qDn] = await Promise.all([
      quote({
        k, side: 'HIGHER', barrier: predHigh, durationSec,
        distance: safeDistUp, trueP: truePUp, sigmaBlock: legSigmaBlock(model, 'HIGHER'),
      }),
      quote({
        k, side: 'LOWER', barrier: predLow, durationSec,
        distance: safeDistDn, trueP: truePDn, sigmaBlock: legSigmaBlock(model, 'LOWER'),
      }),
    ]);

    const c = { k, distanceUp: safeDistUp, distanceDn: safeDistDn, predHigh, predLow, truePUp, truePDn };
    if (qUp) {
      c.payoutUp = qUp.payout;
      c.impliedPUp = qUp.impliedP;
      c.evUp = (truePUp - qUp.impliedP) * qUp.payout;
    }
    if (qDn) {
      c.payoutDn = qDn.payout;
      c.impliedPDn = qDn.impliedP;
      c.evDn = (truePDn - qDn.impliedP) * qDn.payout;
    }
    if (c.evUp !== undefined && c.evDn !== undefined) c.evBlock = c.evUp + c.evDn;
    candidates.push(c);
  }

  let best = null;
  for (const c of candidates) {
    if (c.evBlock === undefined) continue;
    if (!best || c.evBlock > best.evBlock) best = c;
  }
  const selectedK = best && best.evBlock >= minEv ? best.k : null;
  return { model, blockOpen: spot, candidates, best, selectedK };
}

// ─── State Management ───────────────────────────────────────────────────────────

/**
 * Global state object (replaces zustand store).
 */
const state = {
  status: 'idle',
  account: { loginid: null, type: null, balance: null, currency: null },
  session: {
    startedAt: Date.now(),
    trades: 0,
    wins: 0,
    losses: 0,
    legsWon: 0,
    legsLost: 0,
    totalProfit: 0,
    largestWin: 0,
    largestLoss: 0,
    consecutiveLosses: 0,
    dayProfit: 0,
    dayKey: new Date().toISOString().slice(0, 10),
  },
  currentPair: null,
  halted: false,
  haltReason: null,
  lastSpot: null,
  openContractIds: new Set(),
};

/**
 * Add a session result (win/loss) and update stats.
 */
function addSessionResult(profit, legs = { won: 0, lost: 0 }) {
  const s = state.session;
  const won = profit > 0;

  s.trades++;
  s.wins += won ? 1 : 0;
  s.losses += won ? 0 : 1;
  s.legsWon += legs.won;
  s.legsLost += legs.lost;
  s.totalProfit += profit;
  s.largestWin = profit > s.largestWin ? profit : s.largestWin;
  s.largestLoss = profit < s.largestLoss ? profit : s.largestLoss;
  s.consecutiveLosses = won ? 0 : s.consecutiveLosses + 1;
  s.dayProfit += profit;

  return s;
}

/**
 * Halt the bot with a reason.
 */
function halt(reason) {
  state.halted = true;
  state.haltReason = reason;
  LOGGER.warn(`Bot halted: ${reason}`);
}

/**
 * Unhalt the bot.
 */
function unhalt() {
  state.halted = false;
  state.haltReason = null;
  LOGGER.info('Bot unhalted');
}

/**
 * Reset session stats.
 */
function resetSession() {
  state.session = {
    startedAt: Date.now(),
    trades: 0,
    wins: 0,
    losses: 0,
    legsWon: 0,
    legsLost: 0,
    totalProfit: 0,
    largestWin: 0,
    largestLoss: 0,
    consecutiveLosses: 0,
    dayProfit: 0,
    dayKey: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Set the current pair.
 */
function setPair(p) {
  state.currentPair = p;
}

/**
 * Update a leg in the current pair.
 */
function updateLeg(side, patch) {
  if (!state.currentPair) return;
  const key = side === 'HIGHER' ? 'higher' : 'lower';
  const existing = state.currentPair[key];
  if (!existing) return;
  state.currentPair[key] = { ...existing, ...patch };
}

/**
 * Mark TP as triggered.
 */
function markTpTriggered(reason) {
  if (!state.currentPair) return;
  state.currentPair.tpTriggered = true;
  if (reason) state.currentPair.exitReason = reason;
}

/**
 * Finalise the current pair (move to history).
 */
function finalisePair() {
  const p = state.currentPair;
  if (!p) return null;
  state.currentPair = null;
  return p;
}

/**
 * Restore session state from persisted data.
 */
function restoreSession(s) {
  state.session = { ...state.session, ...s };
}

/**
 * Set session day key and profit.
 */
function setSessionDay(dayProfit, dayKey) {
  state.session.dayProfit = dayProfit;
  state.session.dayKey = dayKey;
}

// ─── State Persistence ──────────────────────────────────────────────────────────

function fileExists(p) {
  try {
    fs.readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load session state from disk. Returns null when the file is missing,
 * unreadable, or belongs to a different UTC day (session reset on new day).
 */
function loadState(path) {
  if (!path || !fileExists(path)) return null;
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (data.dayKey !== today) return null;
    return {
      startedAt: Date.now(),
      trades: data.trades ?? 0,
      wins: data.wins ?? 0,
      losses: data.losses ?? 0,
      legsWon: data.legsWon ?? 0,
      legsLost: data.legsLost ?? 0,
      totalProfit: data.totalProfit ?? 0,
      largestWin: data.largestWin ?? 0,
      largestLoss: data.largestLoss ?? 0,
      consecutiveLosses: data.consecutiveLosses ?? 0,
      dayProfit: data.dayProfit ?? 0,
      dayKey: data.dayKey,
    };
  } catch {
    return null;
  }
}

/**
 * Save session state to disk. Creates the file and parent directories on
 * first write. Failures are silently swallowed — persistence is best-effort.
 */
function saveState(filePath, session) {
  if (!filePath) return;
  try {
    const parent = dirname(filePath);
    if (parent && parent !== '.') fs.mkdirSync(parent, { recursive: true });
    const data = {
      dayKey: session.dayKey,
      trades: session.trades,
      wins: session.wins,
      losses: session.losses,
      legsWon: session.legsWon,
      legsLost: session.legsLost,
      totalProfit: session.totalProfit,
      largestWin: session.largestWin,
      largestLoss: session.largestLoss,
      consecutiveLosses: session.consecutiveLosses,
      dayProfit: session.dayProfit,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  } catch {
    // Best-effort — don't break the trading loop over persistence.
  }
}

// ─── Ledger ─────────────────────────────────────────────────────────────────────

const LEDGER_COLUMNS = [
  'at', 'block', 'mode', 'source', 'days_used', 'ev_k', 'open', 'pred_h',
  'pred_l', 'exit', 'pnl_up', 'pnl_dn', 'pnl_block', 'session_pnl',
];

function ledgerHeader() {
  return LEDGER_COLUMNS.join(',');
}

/**
 * Escape a CSV field.
 */
function esc(v) {
  const s = v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ledgerRow(r) {
  return [
    r.at, r.block, r.mode, r.source, r.daysUsed, r.evK ?? '', r.open, r.predH,
    r.predL, r.exit, r.pnlUp, r.pnlDn, r.pnlBlock, r.sessionPnl,
  ].map(esc).join(',');
}

function parseLedger(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line === ledgerHeader()) continue;
    const c = line.split(',');
    if (c.length < LEDGER_COLUMNS.length) continue;
    const n = (i) => Number(c[i] ?? NaN);
    out.push({
      at: n(0),
      block: c[1] ?? '',
      mode: c[2] ?? '',
      source: c[3] ?? '',
      daysUsed: n(4),
      evK: c[5] === '' ? undefined : n(5),
      open: n(6),
      predH: n(7),
      predL: n(8),
      exit: c[9] ?? 'expiry',
      pnlUp: n(10),
      pnlDn: n(11),
      pnlBlock: n(12),
      sessionPnl: n(13),
    });
  }
  return out;
}

/**
 * Append one row, creating the file + header on first write.
 */
function appendLedgerRow(filePath, row) {
  const first = !fileExists(filePath);
  if (first) {
    const parent = dirname(filePath);
    if (parent && parent !== '.') fs.mkdirSync(parent, { recursive: true });
    fs.appendFileSync(filePath, ledgerHeader() + '\n');
  }
  fs.appendFileSync(filePath, ledgerRow(row) + '\n');
}

/**
 * Load all rows (empty array when the file is missing or unreadable).
 */
function loadLedger(path) {
  try {
    return parseLedger(fs.readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Sum of block P&L whose `at` falls on the given UTC date key.
 */
function ledgerDayPnl(rows, dayKey) {
  let sum = 0;
  for (const r of rows) {
    if (utcDayKey(r.at) === dayKey) sum += r.pnlBlock;
  }
  return sum;
}

// ─── Telegram Service ───────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Create a Telegram notifier. Returns a no-op when token or chatId is missing.
 */
function createTelegramNotifier(token, chatId) {
  const enabled = Boolean(token && chatId);

  async function post(text) {
    if (!enabled) return;
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        LOGGER.warn(`telegram: send failed ${res.status} ${detail}`);
      }
    } catch (err) {
      LOGGER.warn(`telegram: send error — ${err.message || err}`);
    }
  }

  return {
    get enabled() { return enabled; },

    async send(text) {
      await post(text);
    },

    async sendTradeOpen(symbol, blockTime, label, barrier, stakeUsd, evTag) {
      const evLine = evTag ? `\n${evTag}` : '';
      await post(
        `<b>🔵 NodeJS Bot Trade Open</b> ${symbol} ${blockTime}\n` +
        `${label} @ ${barrier}\n` +
        `Stake: $${stakeUsd}${evLine}`
      );
    },

    async sendTradeResult(symbol, pnl, legs, stats) {
      await post(
        `<b>📊 Trade Result</b> ${symbol}\n` +
        `P/L: ${pnl}\n` +
        `${legs}\n\n` +
        `📈 <b>NodeJS Bot Session Stats</b>\n` +
        `Total Trades: ${stats.trades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Ratio: ${stats.winRate}\n` +
        `Net P/L: ${stats.netPnl}`
      );
    },

    async sendHourly(symbol, trades, pnl, winRate, stats) {
      await post(
        `<b>⏱ NodeJS Bot Hourly Report</b> ${symbol}\n` +
        `Blocks Traded (Hour): ${trades}\n` +
        `Hour P/L: ${pnl}\n\n` +
        `📈 <b>Session Summary</b>\n` +
        `Total Trades: ${stats.totalTrades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Rate: ${winRate}\n` +
        `Net P/L: ${stats.netPnl}`
      );
    },

    async sendSessionEnd(symbol, trades, pnl, winRate, reason) {
      await post(
        `<b>🏁 NodeJS Bot Session Ended</b> ${symbol} — ${reason}\n` +
        `Blocks: ${trades}\n` +
        `P/L: ${pnl}\n` +
        `Win rate: ${winRate}`
      );
    },

    async sendEndOfDay(symbol, dateStr, stats) {
      await post(
        `🌙 <b>NodeJS Bot End of Day Report</b> ${symbol} (${dateStr} GMT+1)\n` +
        `Total Trades: ${stats.trades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Rate: ${stats.winRate}\n` +
        `Net P/L: ${stats.netPnl}`
      );
    },
  };
}
// ─── Normalize Helpers ──────────────────────────────────────────────────────────

function normalizeContract(c) {
  return {
    contract_id: Number(c.contract_id),
    is_sold: Number(c.is_sold) || 0,
    status: c.status,
    profit: toNum(c.profit),
    payout: toNum(c.payout),
    buy_price: toNum(c.buy_price),
    bid_price: toNum(c.bid_price),
    entry_spot: toNum(c.entry_spot ?? c.entry_tick),
    current_spot: toNum(c.current_spot),
    exit_tick: toNum(c.exit_tick),
    is_valid_to_sell: toNum(c.is_valid_to_sell),
    date_expiry: toNum(c.date_expiry),
    shortcode: c.shortcode,
    barrier: c.barrier,
  };
}

function normalizeBuy(b) {
  return {
    contract_id: Number(b.contract_id),
    buy_price: toNum(b.buy_price) ?? 0,
    payout: toNum(b.payout) ?? 0,
    purchase_time: Number(b.purchase_time) || 0,
    start_time: Number(b.start_time) || 0,
    longcode: String(b.longcode ?? ''),
    shortcode: String(b.shortcode ?? ''),
    transaction_id: Number(b.transaction_id) || 0,
    balance_after: toNum(b.balance_after),
  };
}

function normalizeSell(s) {
  return {
    contract_id: Number(s.contract_id),
    sold_for: toNum(s.sold_for) ?? 0,
    balance_after: toNum(s.balance_after),
    reference_id: toNum(s.reference_id),
    transaction_id: toNum(s.transaction_id),
  };
}

function normalizeBalance(b) {
  return { balance: toNum(b.balance) ?? 0, currency: String(b.currency ?? ''), loginid: b.loginid };
}

function normalizeTick(t) {
  return { epoch: Number(t.epoch) || 0, quote: toNum(t.quote) ?? 0, symbol: String(t.symbol ?? ''), pip_size: toNum(t.pip_size) ?? 0, id: t.id };
}

function normalizeOhlc(o) {
  return { epoch: Number(o.epoch ?? o.open_time) || 0, open: toNum(o.open) ?? 0, high: toNum(o.high) ?? 0, low: toNum(o.low) ?? 0, close: toNum(o.close) ?? 0, symbol: String(o.symbol ?? ''), granularity: Number(o.granularity) || 0 };
}

function normalizeCandlesResponse(candles) {
  const out = [];
  for (const raw of candles) {
    if (!raw || typeof raw !== 'object') continue;
    const epoch = Number(raw.epoch ?? raw.open_time);
    const open = toNum(raw.open), high = toNum(raw.high), low = toNum(raw.low), close = toNum(raw.close);
    if (!Number.isFinite(epoch) || open === undefined || high === undefined || low === undefined || close === undefined) continue;
    out.push({ epoch, open, high, low, close });
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

function parseDurationStr(s) {
  const match = /^(d+)s*(t|s|m|h|d)$/.test(String(s).trim());
  const re = /^(d+)s*(t|s|m|h|d)$/;
  const m = re.test(String(s).trim());
  if (!m) return undefined;
  const arr = re.exec(String(s).trim());
  const n = Number(arr[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (arr[2]) {
    case 't': return n; case 's': return n; case 'm': return n * 60; case 'h': return n * 3600; case 'd': return n * 86400; default: return undefined;
  }
}
// ─── Deriv REST Auth ────────────────────────────────────────────────────────────

function normalizeAccount(raw) {
  const a = (raw ?? {});
  const balanceRaw = a.balance;
  const balance = typeof balanceRaw === 'number' ? balanceRaw : typeof balanceRaw === 'string' ? Number(balanceRaw) : 0;
  return {
    account_id: String(a.account_id ?? ''),
    account_type: a.account_type === 'real' ? 'real' : 'demo',
    balance: Number.isFinite(balance) ? balance : 0,
    currency: String(a.currency ?? ''),
    status: a.status === 'inactive' ? 'inactive' : 'active',
  };
}

function restHeaders(appId, token) {
  return { 'Deriv-App-ID': appId, Authorization: 'Bearer ' + token };
}

async function listAccounts(appId, token) {
  const res = await fetch(DERIV_REST_BASE + '/accounts', { method: 'GET', headers: restHeaders(appId, token) });
  if (!res.ok) throw new Error('list accounts failed: ' + res.status);
  const json = await res.json();
  if (!json?.data || !Array.isArray(json.data)) throw new Error('list accounts: malformed response');
  return json.data.map(normalizeAccount);
}

async function getOtpUrl(appId, token, accountId) {
  const res = await fetch(DERIV_REST_BASE + '/accounts/' + encodeURIComponent(accountId) + '/otp', {
    method: 'POST', headers: restHeaders(appId, token),
  });
  if (!res.ok) throw new Error('get otp failed: ' + res.status);
  const json = await res.json();
  const url = json?.data?.url;
  if (!url) throw new Error('get otp: missing data.url in response');
  return url;
}

function pickDefaultAccount(accounts, preferred) {
  const active = accounts.filter(a => a.status === 'active');
  if (preferred) { const match = active.find(a => a.account_type === preferred); if (match) return match; }
  return active.find(a => a.account_type === 'demo') ?? active.find(a => a.account_type === 'real') ?? active[0] ?? null;
}

// ─── DerivWS Client ─────────────────────────────────────────────────────────────

class DerivWS {
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.listeners = {
      tick: new Set(), ohlc: new Set(), balance: new Set(), contract: new Set(),
      status: new Set(), error: new Set(), info: new Set(), reconnect: new Set(),
    };
    this.pingTimer = null;
    this.rolloverTimer = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.selectedAccount = null;
  }

  getAccount() { return this.selectedAccount; }
  on(event, handler) { this.listeners[event].add(handler); return () => this.listeners[event].delete(handler); }
  emit(event, ...args) { for (const h of this.listeners[event]) h(...args); }

  async connect() {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.emit('status', 'connecting');
    const accounts = await listAccounts(this.opts.appId, this.opts.token);
    if (accounts.length === 0) throw new Error('no accounts returned');
    let account = null;
    if (this.opts.accountId) {
      account = accounts.find(a => a.account_id === this.opts.accountId) ?? null;
      if (!account) throw new Error('account ' + this.opts.accountId + ' not found');
    } else {
      account = pickDefaultAccount(accounts, this.opts.preferAccountType);
      if (!account) throw new Error('no active account found');
    }
    this.selectedAccount = account;
    const wsUrl = await getOtpUrl(this.opts.appId, this.opts.token, account.account_id);
    this.ws = await this.openSocket(wsUrl);
    this.startPing();
    this.scheduleRollover();
    this.emit('status', 'open');
    return account;
  }

  openSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      ws.on('open', () => { if (!settled) { settled = true; resolve(ws); } });
      ws.on('message', (data) => { try { this.handleMessage(JSON.parse(data.toString())); } catch (e) { /* ignore */ } });
      ws.on('error', (err) => {
        if (!settled) { settled = true; reject(new Error('ws error: ' + (err.message ?? ''))); return; }
        this.emit('error', 'ws error: ' + (err.message ?? ''));
      });
      ws.on('close', (code, reason) => {
        if (!settled) { settled = true; reject(new Error('WebSocket closed: ' + (code ?? '') + ' ' + (reason?.toString() ?? ''))); return; }
        this.handleClose(ws, code, reason);
      });
    });
  }

  handleClose(ws, code, reason) {
    if (ws !== this.ws) return;
    this.stopPing();
    this.clearRolloverTimer();
    if (this.intentionalClose) { this.emit('status', 'closed'); return; }
    this.emit('info', 'connection lost — reconnecting…');
    this.scheduleReactiveReconnect();
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopPing();
    this.clearRolloverTimer();
    this.clearReconnectTimer();
    if (this.ws) { try { this.ws.close(); } catch { } this.ws = null; }
    for (const p of this.pending.values()) p.reject(new Error('WebSocket closed'));
    this.pending.clear();
  }

  scheduleRollover() {
    this.clearRolloverTimer();
    this.rolloverTimer = setTimeout(() => this.performRollover(), SESSION_ROLLOVER_MS);
  }
  clearRolloverTimer() { if (this.rolloverTimer) { clearTimeout(this.rolloverTimer); this.rolloverTimer = null; } }
  clearReconnectTimer() { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; } }

  async performRollover() {
    if (this.intentionalClose || this.reconnecting || !this.selectedAccount) return;
    this.reconnecting = true;
    this.emit('status', 'reconnecting');
    this.emit('info', 'session rollover');
    const oldWs = this.ws;
    try {
      const wsUrl = await getOtpUrl(this.opts.appId, this.opts.token, this.selectedAccount.account_id);
      if (this.intentionalClose) return;
      const newWs = await this.openSocket(wsUrl);
      if (this.intentionalClose) { try { newWs.close(); } catch { } return; }
      this.ws = newWs;
      this.stopPing();
      this.startPing();
      this.reconnectAttempts = 0;
      this.rejectPending('session rolled over');
      if (oldWs) { try { oldWs.close(); } catch { } }
      this.scheduleRollover();
      this.emit('status', 'open');
      this.emit('info', 'session rollover complete');
      this.emit('reconnect');
    } catch (err) {
      this.emit('error', 'rollover failed: ' + (err.message || String(err)));
      if (!oldWs || oldWs.readyState !== 1) this.scheduleReactiveReconnect();
      else { this.clearRolloverTimer(); this.rolloverTimer = setTimeout(() => this.performRollover(), RECONNECT_MAX_MS); }
    } finally { this.reconnecting = false; }
  }

  scheduleReactiveReconnect() {
    if (this.intentionalClose) return;
    this.clearReconnectTimer();
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) { this.emit('error', 'reconnect gave up'); this.emit('status', 'closed'); return; }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    this.emit('status', 'reconnecting');
    this.emit('info', 'reconnect attempt ' + (attempt + 1) + '/' + RECONNECT_MAX_ATTEMPTS);
    this.reconnectTimer = setTimeout(() => this.attemptReactiveReconnect(), delay);
  }

  async attemptReactiveReconnect() {
    if (this.intentionalClose || this.reconnecting || !this.selectedAccount) return;
    this.reconnecting = true;
    try {
      const wsUrl = await getOtpUrl(this.opts.appId, this.opts.token, this.selectedAccount.account_id);
      if (this.intentionalClose) return;
      const newWs = await this.openSocket(wsUrl);
      if (this.intentionalClose) { try { newWs.close(); } catch { } return; }
      this.ws = newWs;
      this.startPing();
      this.reconnectAttempts = 0;
      this.rejectPending('reconnected');
      this.scheduleRollover();
      this.emit('status', 'open');
      this.emit('info', 'reconnected');
      this.emit('reconnect');
    } catch (e) {
      if (this.intentionalClose) return;
      this.emit('error', 'reconnect failed: ' + (e.message || String(e)));
      this.scheduleReactiveReconnect();
    } finally { this.reconnecting = false; }
  }

  rejectPending(reason) { for (const p of this.pending.values()) p.reject(new Error(reason)); this.pending.clear(); }
  startPing() { this.stopPing(); this.pingTimer = setInterval(() => this.raw({ ping: 1 }), PING_INTERVAL_MS); }
  stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }
  raw(payload) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload)); }

  send(payload) {
    const req_id = ++this.reqId;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error('WebSocket not open')); return; }
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify(Object.assign({}, payload, { req_id })));
    });
  }

  handleMessage(data) {
    const reqId = data.req_id, msgType = data.msg_type, err = data.error;
    if (reqId && this.pending.has(reqId)) {
      const pend = this.pending.get(reqId);
      if (err) { pend.reject(new Error('[' + (err.code ?? 'Error') + '] ' + (err.message ?? 'Unknown'))); this.pending.delete(reqId); return; }
      pend.resolve(data);
      this.pending.delete(reqId);
    }
    if (err && !reqId) this.emit('error', (err.code ?? 'Error') + ': ' + (err.message ?? 'Unknown'));
    switch (msgType) {
      case 'tick': if (data.tick) this.emit('tick',      normalizeTick(data.tick)); break;
      case 'ohlc': if (data.ohlc) this.emit('ohlc', normalizeOhlc(data.ohlc)); break;
      case 'balance': if (data.balance) this.emit('balance', normalizeBalance(data.balance)); break;
      case 'proposal_open_contract': if (data.proposal_open_contract) this.emit('contract', normalizeContract(data.proposal_open_contract)); break;
    }
  }

  async subscribeBalance() { await this.send({ balance: 1, subscribe: 1 }); }
  async subscribeTicks(symbol) { await this.send({ ticks: symbol, subscribe: 1 }); }

  async getCandles(symbol, granularity, count, subscribe = false) {
    const res = await this.send({ ticks_history: symbol, end: 'latest', count, style: 'candles', granularity, ...(subscribe ? { subscribe: 1 } : {}) });
    return normalizeCandlesResponse(res.candles ?? []);
  }

  async fetchCandlesHistory(symbol, granularity, count) {
    const out = [];
    let end = 'latest', prevEarliest = Infinity;
    while (out.length < count) {
      const want = Math.min(1000, count - out.length);
      const res = await this.send({ ticks_history: symbol, end, count: want, style: 'candles', granularity });
      const page = normalizeCandlesResponse(res.candles ?? []);
      if (page.length === 0) break;
      const earliest = page[0].epoch;
      if (earliest >= prevEarliest) break;
      prevEarliest = earliest;
      out.push(...page);
      if (page.length < want) break;
      end = earliest;
    }
    const byEpoch = new Map();
    for (const c of out) byEpoch.set(c.epoch, c);
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  }

  async getProposal(params) {
    const res = await this.send({ proposal: 1, amount: params.amount, basis: params.basis ?? 'stake', contract_type: params.contract_type, currency: params.currency, duration: params.duration, duration_unit: params.duration_unit, underlying_symbol: params.symbol, barrier: params.barrier });
    const p = res.proposal ?? {};
    const id = typeof p.id === 'string' ? p.id : '';
    if (!id) throw new Error('proposal: missing id');
    const askPrice = toNum(p.ask_price) ?? 0;
    const payout = toNum(p.payout) ?? 0;
    return { id, ask_price: askPrice, payout, spot: toNum(p.spot) ?? 0, impliedP: payout > 0 ? askPrice / payout : undefined };
  }

  async buyContract(params, slippagePct = 0.1) {
    const proposal = await this.getProposal(params);
    const maxPrice = +(proposal.ask_price * (1 + Math.max(0, slippagePct))).toFixed(2);
    const res = await this.send({ buy: proposal.id, price: maxPrice, subscribe: 1 });
    return Object.assign({}, normalizeBuy(res.buy ?? {}), { impliedP: proposal.impliedP });
  }

  async buyProposal(proposalId, askPrice, slippagePct = 0.1) {
    const maxPrice = +(askPrice * (1 + Math.max(0, slippagePct))).toFixed(2);
    const res = await this.send({ buy: proposalId, price: maxPrice, subscribe: 1 });
    return normalizeBuy(res.buy ?? {});
  }

  async sellContract(contractId, price = 0) {
    const res = await this.send({ sell: contractId, price });
    return normalizeSell(res.sell ?? {});
  }

  async subscribeOpenContract(contractId) { await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }); }
  async forgetAll(streams) { await this.send({ forget_all: streams }); }

  async getContractsFor(symbol) {
    const res = await this.send({ contracts_for: symbol });
    const cf = res.contracts_for ?? {};
    const available = cf.available ?? [];
    const types = new Set(), constraints = {};
    for (const raw of available) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw.contract_type;
      if (typeof t !== 'string') continue;
      types.add(t);
      const minSec = typeof raw.min_contract_duration === 'string' ? parseDurationStr(raw.min_contract_duration) : undefined;
      const maxSec = typeof raw.max_contract_duration === 'string' ? parseDurationStr(raw.max_contract_duration) : undefined;
      const prev = constraints[t] ?? {};
      constraints[t] = {
        minDurationSec: minSec !== undefined ? (prev.minDurationSec === undefined ? minSec : Math.min(prev.minDurationSec, minSec)) : prev.minDurationSec,
        maxDurationSec: maxSec !== undefined ? (prev.maxDurationSec === undefined ? maxSec : Math.max(prev.maxDurationSec, maxSec)) : prev.maxDurationSec,
      };
    }
    return { symbol, contract_types: types, pip_size: toNum(cf.pip_size) ?? 0, constraints };
  }
}// ─── Logging Adapter ────────────────────────────────────────────────────────────

function appendLog(kind, msg) {
  switch (kind) {
    case 'block': LOGGER.block(msg); break;
    case 'sell': LOGGER.sell(msg); break;
    case 'trade-open':
    case 'trade-close': LOGGER.trade(msg); break;
    case 'warn': LOGGER.warn(msg); break;
    case 'error': LOGGER.error(msg); break;
    case 'system': LOGGER.system(msg); break;
    default: LOGGER.info(msg);
  }
}

function setStatus(s) { state.status = s; }
function setSpot(q) { state.lastSpot = q; }
function setAccount(a) { state.account = Object.assign({}, state.account, a); }

// ─── BlockClock ─────────────────────────────────────────────────────────────────

class BlockClock {
  constructor(blockSec) {
    if (!Number.isFinite(blockSec) || blockSec <= 0) throw new Error('BlockClock: blockSec must be > 0');
    this.blockSec = blockSec;
    this.timer = null;
    this.onStart = new Set();
    this.onEnd = new Set();
    this.stopped = true;
    this.current = BlockClock.windowAt(Date.now() / 1000, blockSec);
  }

  static windowAt(nowSec, blockSec) {
    const start = Math.floor(nowSec / blockSec) * blockSec;
    return { start, end: start + blockSec };
  }

  currentWindow() { return { ...this.current }; }
  secondsUntilEnd(nowSec = Date.now() / 1000) { return Math.max(0, this.current.end - nowSec); }

  on(event, h) {
    const set = event === 'block-start' ? this.onStart : this.onEnd;
    set.add(h);
    return () => set.delete(h);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule() {
    if (this.stopped) return;
    const endMs = this.current.end * 1000;
    const delay = Math.max(50, endMs - Date.now() + 50);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  tick() {
    if (this.stopped) return;
    const closed = this.current;
    const next = BlockClock.windowAt(Date.now() / 1000, this.blockSec);
    this.current = next;
    for (const h of this.onEnd) h(closed);
    for (const h of this.onStart) h(next);
    this.schedule();
  }
}

// ─── PairTrader ─────────────────────────────────────────────────────────────────

function legProfit(leg) { return leg ? leg.liveProfit : 0; }

class PairTrader {
  constructor(deps) {
    this.deps = deps;
    this.pipDigits = 2;
    this.selling = false;
    this.constraints = {};
    this.activeModel = null;
    this.exitState = newExitState();
    this.activeEdges = null;
    this.activeEffectiveStake = 0;
    this.prefetchMap = new Map();
  }

  setPipDigits(d) { if (d > 0 && d < 12) this.pipDigits = d; }
  setConstraints(c) { this.constraints = c; }

  async openPair(p) {
    const cfg = this.deps.cfg();
    const nowSec = Date.now() / 1000;
    const durationSec = Math.max(15, Math.floor(p.blockEnd - nowSec));
    if (durationSec < 15) {
      appendLog('warn', 'block ' + timeHM(p.blockStart) + ' — only ' + durationSec + 's left, skipping pair');
      return;
    }

    this.activeModel = p.model ?? null;
    this.activeEdges = p.edges ?? null;
    this.activeEffectiveStake = p.effectiveStake ?? cfg.STAKE;
    this.exitState = newExitState();
    this.prefetchMap.clear();
    const spot = p.spot;

    // Apply barrier floor to both predictions.
    const floored = enforceBarrierFloor(spot, p.predictedHigh, p.predictedLow, this.activeModel, this.pipDigits);
    const predHigh = floored.predHigh;
    const predLow = floored.predLow;
    if (floored.adjusted) {
      appendLog('info', 'barrier floor applied — predH ' + p.predictedHigh.toFixed(this.pipDigits) + '->' + predHigh.toFixed(this.pipDigits) + ' predL ' + p.predictedLow.toFixed(this.pipDigits) + '->' + predLow.toFixed(this.pipDigits));
    }

    const pair = {
      blockStart: p.blockStart,
      blockEnd: p.blockEnd,
      blockOpen: p.blockOpen,
      predictedHigh: predHigh,
      predictedLow: predLow,
      predictionSource: p.predictionSource,
      daysUsed: p.daysUsed,
      higher: null,
      lower: null,
      tpTriggered: false,
      evK: p.evK,
    };
    setPair(pair);
    this.selling = false;

    const evTag = (cfg.EV_MODE && p.evK !== undefined) ? ' · ev K=' + p.evK.toFixed(2) : '';
    const dirTag = p.tradeDirection === 'positive-ev' ? ' · +EV only' : '';
    const effectiveBase = p.effectiveStake ?? cfg.STAKE;
    const martingaleActive = effectiveBase > cfg.STAKE;
    const mgTag = martingaleActive ? ' · martingale $' + effectiveBase.toFixed(2) : '';
    appendLog('block',
      'new block ' + timeHM(p.blockStart) + '–' + timeHM(p.blockEnd) +
      '  open=' + p.blockOpen.toFixed(this.pipDigits) +
      '  predH=' + predHigh.toFixed(this.pipDigits) +
      '  predL=' + predLow.toFixed(this.pipDigits) +
      '  [' + cfg.MODE + ' · ' + p.predictionSource + (p.daysUsed ? ' ' + p.daysUsed + 'd' : '') + evTag + dirTag + mgTag + ']'
    );

    // ── Build leg specs ──
    const prefetchEntries = [];
    const skippedSides = new Set();
    const minStake = 0.35;

    const buildLegSpec = (side, barrier, spotPrice) => {
      const ct = contractTypeFor(cfg.MODE, side);
      const dv = ct === 'NOTOUCH' ? { value: cfg.BLOCK_MINUTES, unit: 'm' } : { value: durationSec, unit: 's' };
      const dist = Math.abs(barrier - spotPrice);
      const trueP = this.activeModel ? winRate(this.activeModel, cfg.MODE, side, dist) : 0.5;
      const edge = p.edges ? p.edges[side] : (this.activeEdges ? this.activeEdges[side] : 0);

      // positive-ev mode: skip if edge is not positive enough
      if (p.tradeDirection === 'positive-ev') {
        const evDollar = edge * (effectiveBase / (1 / 1.95));
        if (!Number.isFinite(edge) || edge <= 0 || evDollar < cfg.MIN_EV) {
          return { skip: true, reason: 'positive-ev mode, edge=' + (isFinite(edge) ? edge.toFixed(4) : 'NaN') };
        }
      }

      // Stake sizing
      let targetStake = effectiveBase;
      let staggerInfo = null;
      if (cfg.EV_STAGGER && !martingaleActive) {
        staggerInfo = staggerStake({ baseStake: effectiveBase, edge });
        targetStake = staggerInfo.stake;
      }

      // Skip-on-clip: if stagger intended a downsize but floor clipped it up, skip the leg.
      if (staggerInfo && staggerInfo.clipped && staggerInfo.ratio < 1) {
        return { skip: true, reason: 'stagger clipped below $' + minStake + ' (intended $' + (effectiveBase * staggerInfo.ratio).toFixed(2) + '), edge=' + edge.toFixed(4) + ' — skipping' };
      }

      return { skip: false, side, barrier, durVal: dv.value, durUnit: dv.unit, ct, dist, trueP, targetStake, edge };
    };

    if (predHigh > spot) {
      const spec = buildLegSpec('HIGHER', predHigh, spot);
      if (spec.skip) {
        skippedSides.add('HIGHER');
        appendLog('info', 'upper leg (' + spec.ct + ') skipped — ' + spec.reason);
      } else {
        prefetchEntries.push(spec);
      }
    } else {
      skippedSides.add('HIGHER');
      appendLog('warn', 'upper leg skipped — predH ' + predHigh.toFixed(this.pipDigits) + ' <= spot ' + spot.toFixed(this.pipDigits));
    }
    if (predLow < spot) {
      const spec = buildLegSpec('LOWER', predLow, spot);
      if (spec.skip) {
        skippedSides.add('LOWER');
        appendLog('info', 'lower leg (' + spec.ct + ') skipped — ' + spec.reason);
      } else {
        prefetchEntries.push(spec);
      }
    } else {
      skippedSides.add('LOWER');
      appendLog('warn', 'lower leg skipped — predL ' + predLow.toFixed(this.pipDigits) + ' >= spot ' + spot.toFixed(this.pipDigits));
    }

    // ── Serialized prefetch proposals (sequential to avoid RateLimit) ──
    if (prefetchEntries.length > 0) {
      for (const entry of prefetchEntries) {
        try {
          const pResult = await this.deps.ws.getProposal({
            amount: entry.targetStake,
            currency: cfg.CURRENCY,
            contract_type: entry.ct,
            duration: entry.durVal,
            duration_unit: entry.durUnit,
            symbol: cfg.SYMBOL,
            barrier: formatBarrier(entry.barrier, this.pipDigits),
          });
          if (pResult.payout > 0 && pResult.impliedP !== undefined) {
            this.prefetchMap.set(entry.side, {
              proposalId: pResult.id,
              askPrice: pResult.ask_price,
              impliedP: pResult.impliedP,
              edge: entry.edge,
              stake: entry.targetStake,
              payout: pResult.payout,
            });
          }
        } catch (err) {
          appendLog('warn', entry.side + ' proposal prefetch failed — will request fresh quote: ' + (err.message || String(err)));
        }
        // Brief pause between proposals to reduce RateLimit risk.
        if (prefetchEntries.length > 1) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }

    // ── Build task list ──
    const tasks = [];
    if (!skippedSides.has('HIGHER')) {
      const prefetch = this.prefetchMap.get('HIGHER');
      tasks.push({ side: 'HIGHER', task: () => this.openLeg('HIGHER', predHigh, durationSec, spot, prefetch), edge: prefetch ? prefetch.edge : (p.edges ? p.edges.HIGHER : 0) });
    }
    if (!skippedSides.has('LOWER')) {
      const prefetch = this.prefetchMap.get('LOWER');
      tasks.push({ side: 'LOWER', task: () => this.openLeg('LOWER', predLow, durationSec, spot, prefetch), edge: prefetch ? prefetch.edge : (p.edges ? p.edges.LOWER : 0) });
    }

    // ── Positive-ev mode: only open the best leg ──
    if (p.tradeDirection === 'positive-ev' && tasks.length > 1) {
      tasks.sort((a, b) => b.edge - a.edge);
      const winner = tasks[0];
      const losers = tasks.slice(1);
      const ct = contractTypeFor(cfg.MODE, winner.side);
      appendLog('info', 'positive-ev: opening only ' + winner.side + ' (' + ct + ') — ev=' + winner.edge.toFixed(4) + ' (' + losers.map((l) => l.side + ' ' + l.edge.toFixed(4)).join(', ') + ')');
      await Promise.allSettled([winner.task()]);
      return;
    }

    // ── Both-or-none: open legs in parallel ──
    if (tasks.length === 0) return;

    const results = await Promise.allSettled(tasks.map((t) => t.task()));

    // Count successfully injected legs.
    const currentPair = state.currentPair;
    const injectedCount = currentPair ? [currentPair.higher, currentPair.lower].filter(l => l && !l.resolved).length : 0;

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        appendLog('error', tasks[i].side + ' leg failed: ' + (results[i].reason?.message || String(results[i].reason)));
      }
    }

    // ── Atomic pair enforcement ──
    if (cfg.TRADE_DIRECTION === 'both' && tasks.length === 2 && injectedCount === 1) {
      appendLog('warn', 'atomic pair: only 1/2 legs injected — attempting retry for failed side');
      const failedEntry = tasks.find((t, i) => results[i].status !== 'fulfilled' || !this._legInjected(t.side));
      if (failedEntry) {
        await failedEntry.task();
        const afterRetry = state.currentPair;
        const retryCount = afterRetry ? [afterRetry.higher, afterRetry.lower].filter(l => l && !l.resolved).length : 0;
        if (retryCount < 2) {
          appendLog('warn', 'atomic pair: retry failed — rolling back single leg');
          await this._rollbackSingleLeg();
        }
      } else {
        await this._rollbackSingleLeg();
      }
    } else if (cfg.TRADE_DIRECTION === 'both' && tasks.length === 1 && injectedCount === 0) {
      appendLog('warn', 'atomic pair: single-leg queued but failed — no trade this block');
    }
  }

  _legInjected(side) {
    const pair = state.currentPair;
    if (!pair) return false;
    const leg = side === 'HIGHER' ? pair.higher : pair.lower;
    return leg && !leg.resolved;
  }

  async _rollbackSingleLeg() {
    const pair = state.currentPair;
    if (!pair) return;
    const cfg = this.deps.cfg();
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.MODE, leg.side);
      if (cfg.DRY_RUN) {
        updateLeg(leg.side, { status: 'sold', resolved: true, liveProfit: -leg.stake });
        appendLog('sell', 'DRY ' + label + ' rollback — no trade (single-leg abort)');
        continue;
      }
      if (leg.isValidToSell === 1) {
        try {
          const res = await this.deps.ws.sellContract(leg.contractId, 0);
          const realised = (res.sold_for ?? 0) - (leg.buyPrice ?? leg.stake);
          updateLeg(leg.side, { status: 'sold', resolved: true, liveProfit: realised });
          appendLog('sell', label + ' rollback sold — realised=' + (realised >= 0 ? '+' : '') + realised.toFixed(2));
        } catch (err) {
          appendLog('warn', label + ' rollback sell failed: ' + (err.message || String(err)) + ' — riding to expiry');
          updateLeg(leg.side, { status: 'open', resolved: false });
        }
      } else {
        appendLog('warn', label + ' not sellable for rollback — riding to expiry');
      }
    }
    // Clear pair so it doesn't count in session accounting.
    finalisePair();
  }

  async openLeg(side, barrier, durationSec, spot, prefetch) {
    const cfg = this.deps.cfg();
    const key = side === 'HIGHER' ? 'higher' : 'lower';
    const contractType = contractTypeFor(cfg.MODE, side);
    const label = legDisplayName(cfg.MODE, side);

    // Positive-ev fallback guard.
    const edge = prefetch ? prefetch.edge : (cfg.EV_MODE ? (this.activeEdges ? this.activeEdges[side] : 0) : 0);
    if (cfg.TRADE_DIRECTION === 'positive-ev' && edge <= 0) {
      appendLog('info', label + ' skipped (fallback guard) — positive-ev, edge=' + edge.toFixed(4) + ' <= 0');
      return;
    }

    // Stake sizing — when martingale is active, suppress EV_STAGGER to guarantee
    // deterministic STAKE * MULTIPLIER^losses per user MARTINGALE_ENABLED setting.
    const martingaleActive = this.activeEffectiveStake > cfg.STAKE + 1e-9;
    let stake = this.activeEffectiveStake;
    if (cfg.EV_STAGGER && !martingaleActive) {
      const sInfo = staggerStake({ baseStake: this.activeEffectiveStake, edge });
      stake = sInfo.stake;
    }

    // DRY RUN path.
    if (cfg.DRY_RUN) {
      return this._openLegDryRun(side, barrier, durationSec, spot, prefetch, stake, edge);
    }

    // LIVE path — unified retry.
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Fresh duration recalc on each attempt.
      const freshNowSec = Date.now() / 1000;
      const freshDurationSec = Math.max(15, Math.floor(durationSec + (freshNowSec - Date.now() / 1000)));
      const blockSec = cfg.BLOCK_MINUTES * 60;
      let durationValue;
      let durationUnit;
      if (contractType === 'NOTOUCH') {
        durationUnit = 'm';
        const startupSlackSec = 30;
        if (freshDurationSec < blockSec - startupSlackSec) {
          appendLog('warn', label + ' skipped — ' + freshDurationSec + 's left vs full block ' + blockSec + '; NOTOUCH only trades fresh blocks');
          return;
        }
        durationValue = cfg.BLOCK_MINUTES;
      } else {
        durationUnit = 's';
        durationValue = Math.max(15, Math.floor(durationSec - (Date.now() / 1000 - freshNowSec)));
      }
      const barrierStr = formatBarrier(barrier, this.pipDigits);
      const durSpec = String(durationValue) + durationUnit;

      // Duration constraint check.
      const effectiveSec = durationUnit === 'm' ? durationValue * 60 : durationValue;
      const cst = this.constraints[contractType];
      const minD = cst ? cst.minDurationSec : undefined;
      const maxD = cst ? cst.maxDurationSec : undefined;
      if (minD !== undefined && effectiveSec < minD) {
        appendLog('warn', label + ' skipped — ' + effectiveSec + 's < ' + contractType + ' min ' + minD + 's');
        return;
      }
      if (maxD !== undefined && effectiveSec > maxD) {
        durationValue = durationUnit === 'm' ? Math.floor(maxD / 60) : maxD;
      }

      // Re-check spot vs barrier before buy.
      const currentSpot = state.lastSpot ?? spot;
      if (side === 'HIGHER' && barrier <= currentSpot) {
        appendLog('warn', label + ' skipped — barrier ' + barrierStr + ' <= current spot ' + currentSpot.toFixed(this.pipDigits));
        return;
      }
      if (side === 'LOWER' && barrier >= currentSpot) {
        appendLog('warn', label + ' skipped — barrier ' + barrierStr + ' >= current spot ' + currentSpot.toFixed(this.pipDigits));
        return;
      }

      try {
        if (prefetch && attempt === 0) {
          // Use prefetched proposal.
          const buy = await this.deps.ws.buyProposal(prefetch.proposalId, prefetch.askPrice);
          const impliedP = prefetch.impliedP;
          const model = this.activeModel;
          const distance = Math.abs(barrier - spot);
          const trueP = model ? winRate(model, cfg.MODE, side, distance) : undefined;
          const ev = (trueP !== undefined && impliedP !== undefined) ? (trueP - impliedP) * prefetch.payout : undefined;
          const leg = { side, contractId: buy.contract_id, stake: buy.buy_price, payout: prefetch.payout, buyPrice: buy.buy_price, barrier, liveProfit: 0, status: 'open', resolved: false, impliedP, trueP, ev };
          this.deps.registerContractId(buy.contract_id);
          this.injectLeg(key, leg);
          let evTokens = '';
          if (ev !== undefined && impliedP !== undefined) evTokens = ' p=' + fmtPct(trueP) + ' ev=' + fmtSigned(ev);
          let xToken = '';
          if (cfg.EV_STAGGER && prefetch.stake !== cfg.STAKE) xToken = ' x' + (prefetch.stake / cfg.STAKE).toFixed(2);
          appendLog('trade-open', label + ' stake=' + buy.buy_price.toFixed(2) + ' payout=' + prefetch.payout.toFixed(2) + ' barrier=' + barrierStr + ' dur=' + durSpec + ' id=' + buy.contract_id + evTokens + xToken);
          if (this.deps.notify) this.deps.notify.sendTradeOpen(cfg.SYMBOL, timeHM(Date.now() / 1000), label, barrierStr, buy.buy_price.toFixed(2), evTokens || undefined);
          return; // Success, no retry needed.
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (isRetryableError(msg) && attempt < maxRetries) {
          appendLog('warn', label + ' buy (attempt ' + (attempt + 1) + ') transient error: ' + msg + ' — retrying (' + (maxRetries - attempt) + ' left)');
          await new Promise(r => setTimeout(r, 200 + attempt * 150));
          continue;
        }
        appendLog('error', label + ' buy failed (' + contractType + ' dur=' + durSpec + ' barrier=' + barrierStr + '): ' + (attempt > 0 ? '(after ' + attempt + ' retries) ' : '') + msg);
        return;
      }

      try {
        // Fresh proposal + buy (no prefetch, or retry after prefetch failure).
        // Martingale-aware: base on activeEffectiveStake, suppress stagger when martingale active
        const distanceEff = Math.abs(barrier - spot);
        const modelEff = this.activeModel;
        const truePForEff = modelEff ? winRate(modelEff, cfg.MODE, side, distanceEff) : undefined;
        let eff = { stake: this.activeEffectiveStake, edge };
        if (cfg.EV_STAGGER && !martingaleActive && truePForEff !== undefined) {
          eff = await this.resolveLiveStake(side, truePForEff, contractType, durationValue, durationUnit, barrierStr, this.activeEffectiveStake);
        }
        const res = await this.deps.ws.buyContract({
          amount: eff.stake,
          currency: cfg.CURRENCY,
          contract_type: contractType,
          duration: durationValue,
          duration_unit: durationUnit,
          symbol: cfg.SYMBOL,
          barrier: barrierStr,
        });
        const impliedP = res.impliedP;
        const model = this.activeModel;
        const distance = Math.abs(barrier - spot);
        const trueP2 = model ? winRate(model, cfg.MODE, side, distance) : undefined;
        const ev = (trueP2 !== undefined && impliedP !== undefined) ? (trueP2 - impliedP) * res.payout : undefined;
        const leg = { side, contractId: res.contract_id, stake: res.buy_price, payout: res.payout, buyPrice: res.buy_price, barrier, liveProfit: 0, status: 'open', resolved: false, impliedP, trueP: trueP2, ev };
        this.deps.registerContractId(res.contract_id);
        this.injectLeg(key, leg);
        let evTokens = '';
        if (ev !== undefined && impliedP !== undefined) evTokens = ' p=' + fmtPct(trueP2) + ' ev=' + fmtSigned(ev);
        let xToken = '';
        if (cfg.EV_STAGGER && eff.edge !== undefined) xToken = ' x' + (eff.stake / cfg.STAKE).toFixed(2);
        appendLog('trade-open', label + ' stake=' + res.buy_price.toFixed(2) + ' payout=' + res.payout.toFixed(2) + ' barrier=' + barrierStr + ' dur=' + durSpec + ' id=' + res.contract_id + evTokens + xToken);
        if (this.deps.notify) this.deps.notify.sendTradeOpen(cfg.SYMBOL, timeHM(Date.now() / 1000), label, barrierStr, res.buy_price.toFixed(2), evTokens || undefined);
        return; // Success.
      } catch (err) {
        const msg = err.message || String(err);
        if (isRetryableError(msg) && attempt < maxRetries) {
          appendLog('warn', label + ' buyContract (attempt ' + (attempt + 1) + ') transient error: ' + msg + ' — retrying (' + (maxRetries - attempt) + ' left)');
          await new Promise(r => setTimeout(r, 200 + attempt * 150));
          continue;
        }
        appendLog('error', label + ' buy failed (' + contractType + ' dur=' + durSpec + ' barrier=' + barrierStr + '): ' + (attempt > 0 ? '(after ' + attempt + ' retries) ' : '') + msg);
        return;
      }
    }
  }

  _openLegDryRun(side, barrier, durationSec, spot, prefetch, stake, edge) {
    const cfg = this.deps.cfg();
    const key = side === 'HIGHER' ? 'higher' : 'lower';
    const label = legDisplayName(cfg.MODE, side);
    const barrierStr = formatBarrier(barrier, this.pipDigits);
    const contractType = contractTypeFor(cfg.MODE, side);
    const blockSec = cfg.BLOCK_MINUTES * 60;
    let durationValue;
    let durationUnit;
    if (contractType === 'NOTOUCH') {
      durationUnit = 'm';
      durationValue = cfg.BLOCK_MINUTES;
    } else {
      durationUnit = 's';
      durationValue = durationSec;
    }
    const durSpec = String(durationValue) + durationUnit;
    const distance = Math.abs(barrier - spot);
    const model = this.activeModel;
    const trueP = model ? winRate(model, cfg.MODE, side, distance) : 0.5;
    const fakeId = -Math.floor(Math.random() * 1000000000);
    const effectiveBase = this.activeEffectiveStake ?? stake ?? cfg.STAKE;
    const martingaleActive = effectiveBase > cfg.STAKE + 1e-9;
    const sim = (trueP !== undefined && model) ? simulateQuote({ trueP, distance, sigmaBlock: legSigmaBlock(model, side), mode: cfg.MODE, edge: cfg.DRY_RUN_EDGE || 0, stake: effectiveBase }) : { impliedP: 1 / 1.95, payout: effectiveBase * 1.95 };
    const impliedP = sim.impliedP;
    const edge2 = trueP !== undefined ? trueP - impliedP : undefined;
    let stake2 = effectiveBase;
    if (cfg.EV_STAGGER && !martingaleActive && edge2 !== undefined) {
      const sInfo = staggerStake({ baseStake: effectiveBase, edge: edge2 });
      stake2 = sInfo.stake;
    }
    const payout2 = impliedP > 0 ? stake2 / impliedP : sim.payout;
    const ev = (trueP !== undefined && edge2 !== undefined) ? edge2 * payout2 : undefined;
    const leg = { side, contractId: fakeId, stake: stake2, payout: payout2, buyPrice: stake2, barrier, liveProfit: 0, status: 'open', resolved: false, impliedP, trueP, ev };
    this.injectLeg(key, leg);
    let evTokens = '';
    if (ev !== undefined && trueP !== undefined) evTokens = ' p=' + fmtPct(trueP) + ' ev=' + fmtSigned(ev);
    let xToken = '';
    if (cfg.EV_STAGGER && stake2 !== cfg.STAKE) xToken = ' x' + (stake2 / cfg.STAKE).toFixed(2);
    appendLog('trade-open', 'DRY ' + label + ' stake=' + stake2.toFixed(2) + ' payout=' + payout2.toFixed(2) + ' barrier=' + barrierStr + ' dur=' + durSpec + ' id=' + fakeId + evTokens + xToken);
    if (this.deps.notify) this.deps.notify.sendTradeOpen(cfg.SYMBOL, 'DRY ' + timeHM(Date.now() / 1000), label, barrierStr, stake2.toFixed(2), evTokens.trim() || undefined);
  }

  async resolveLiveStake(side, trueP, contractType, durationValue, durationUnit, barrierStr, baseStake) {
    const cfg = this.deps.cfg();
    const base = baseStake ?? this.activeEffectiveStake ?? cfg.STAKE;
    if (cfg.EV_MODE) {
      const edge = this.activeEdges ? this.activeEdges[side] : 0;
      const s = staggerStake({ baseStake: base, edge });
      return { stake: s.stake, edge };
    }
    try {
      const p = await this.deps.ws.getProposal({
        amount: base, currency: cfg.CURRENCY, contract_type: contractType,
        duration: durationValue, duration_unit: durationUnit, symbol: cfg.SYMBOL, barrier: barrierStr,
      });
      if (p.impliedP === undefined) return { stake: base, edge: 0 };
      const edge = trueP - p.impliedP;
      const s = staggerStake({ baseStake: base, edge });
      return { stake: s.stake, edge };
    } catch {
      return { stake: base, edge: 0 };
    }
  }

  injectLeg(key, leg) {
    const pair = state.currentPair;
    if (!pair) return;
    pair[key] = leg;
  }onContractUpdate(u) {
    const pair = state.currentPair;
    if (!pair) return;
    let side = null;
    if (pair.higher && pair.higher.contractId === u.contract_id) side = 'HIGHER';
    else if (pair.lower && pair.lower.contractId === u.contract_id) side = 'LOWER';
    if (!side) return;

    const patch = { liveProfit: u.profit ?? 0, bidPrice: u.bid_price, isValidToSell: u.is_valid_to_sell };
    const status = u.status;
    if (status === 'open' || status === 'won' || status === 'lost' || status === 'sold' || status === 'cancelled') {
      patch.status = status;
    }
    if (status !== 'open') patch.resolved = true;
    updateLeg(side, patch);

    const updated = state.currentPair;
    if (updated) this.maybeTriggerTp(updated);

    if (patch.resolved && u.contract_id) this.deps.unregisterContractId(u.contract_id);
  }

  maybeTriggerTp(pair) {
    if (pair.tpTriggered || this.selling) return;
    const cfg = this.deps.cfg();
    const profit = (pair.higher ? pair.higher.liveProfit : 0) + (pair.lower ? pair.lower.liveProfit : 0);
    const open = [pair.higher, pair.lower].filter((l) => l && !l.resolved);
    if (open.length === 0) return;

    // Normalize TP/SL/trail to stake ratio so exit probability stays
    // constant regardless of effective stake (e.g. 0.35 vs 1.0).
    const stakeRatio = this.activeEffectiveStake / 1.0;
    const blockTp = (cfg.BLOCK_TP ?? 0) * stakeRatio;
    const blockSl = (cfg.BLOCK_SL ?? 0) * stakeRatio;
    const blockTrail = (cfg.BLOCK_TRAIL ?? 0) * stakeRatio;
    const trailArmAt = (blockTp > 0 && blockTrail > 0) ? blockTp * DEFAULT_TRAIL_ARM_FRACTION : 0;
    const dec = evaluatePairExit({ state: this.exitState, profit, blockTp, blockSl, blockTrail, trailArmAt });
    if (!dec.exit) return;

    this.selling = true;
    markTpTriggered(dec.reason);
    const rawTp = cfg.BLOCK_TP ?? 0;
    const rawSl = cfg.BLOCK_SL ?? 0;
    const reason = dec.reason === 'sl'
      ? 'pair P/L ' + (profit <= 0 ? '' : '+') + profit.toFixed(2) + ' <= -sl ' + blockSl.toFixed(2) + ' (raw ' + rawSl.toFixed(2) + ' × ' + stakeRatio.toFixed(2) + ')'
      : dec.reason === 'trail'
        ? 'pair P/L retraced ' + (this.exitState.peakPL - profit).toFixed(2) + ' from peak +' + this.exitState.peakPL.toFixed(2)
        : 'pair P/L ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + ' >= tp ' + blockTp.toFixed(2) + ' (raw ' + rawTp.toFixed(2) + ' × ' + stakeRatio.toFixed(2) + ')';
    appendLog('sell', reason + ' — selling sellable legs');
    void this.sellSellableLegs(pair);
  }

  async sellSellableLegs(pair) {
    const cfg = this.deps.cfg();
    const jobs = [];
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.MODE, leg.side);
      if (cfg.DRY_RUN) {
        updateLeg(leg.side, { status: 'sold', resolved: true });
        appendLog('sell', 'DRY ' + label + ' id=' + leg.contractId + ' sold @ +' + leg.liveProfit.toFixed(2));
        continue;
      }
      if (leg.isValidToSell !== 1) {
        appendLog('warn', label + ' id=' + leg.contractId + ' not sellable right now — riding to expiry');
        continue;
      }
      jobs.push(this.sellOne(leg, label));
    }
    await Promise.allSettled(jobs);
  }

  async sellOne(leg, label) {
    try {
      const res = await this.deps.ws.sellContract(leg.contractId, 0);
      const realised = (res.sold_for ?? leg.liveProfit ?? 0) - (leg.buyPrice ?? leg.stake);
      updateLeg(leg.side, { status: 'sold', resolved: true, liveProfit: realised });
      appendLog('sell', label + ' id=' + leg.contractId + ' sold_for=' + res.sold_for.toFixed(2) + ' realised=' + (realised >= 0 ? '+' : '') + realised.toFixed(2));
    } catch (err) {
      appendLog('error', label + ' id=' + leg.contractId + ' sell failed: ' + (err.message || String(err)));
    }
  }

  async sellOpenLegs() {
    const pair = state.currentPair;
    if (!pair) return;
    const cfg = this.deps.cfg();
    const jobs = [];
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.MODE, leg.side);
      if (cfg.DRY_RUN) {
        updateLeg(leg.side, { status: 'sold', resolved: true });
        appendLog('sell', 'DRY ' + label + ' id=' + leg.contractId + ' sold @ +' + leg.liveProfit.toFixed(2));
        continue;
      }
      if (leg.isValidToSell !== 1) {
        appendLog('warn', label + ' id=' + leg.contractId + ' not sellable right now — riding to expiry');
        continue;
      }
      jobs.push(this.sellOne(leg, label));
    }
    await Promise.allSettled(jobs);
  }

  markToMarket(spot, blockEnd) {
    const pair = state.currentPair;
    if (!pair) return;
    const cfg = this.deps.cfg();
    const model = this.activeModel;
    const secsRemaining = Math.max(0, blockEnd - Date.now() / 1000);
    let touched = false;
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const distance = Math.abs(spot - leg.barrier);
      const sigma = model ? legSigmaBlock(model, leg.side) / Math.sqrt(model.ticks) : undefined;
      const w = (sigma !== undefined && sigma > 0 && secsRemaining > 0)
        ? currentWinProb({ distance: distance, sigmaPerTick: sigma, secondsRemaining: secsRemaining, mode: cfg.MODE })
        : 0.5;
      const profit = markToMarketProfit({ payout: leg.payout, stake: leg.stake, currentWinP: w });
      updateLeg(leg.side, { liveProfit: profit });
      touched = true;
    }
    if (touched) {
      const updated = state.currentPair;
      if (updated) this.maybeTriggerTp(updated);
    }
  }

  realiseAtBlockEnd(spot, intraHigh, intraLow, barRange) {
    const cfg = this.deps.cfg();
    const pair = state.currentPair;
    if (!pair) return null;

    if (cfg.DRY_RUN) {
      for (const leg of [pair.higher, pair.lower]) {
        if (!leg || leg.resolved) continue;
        const label = legDisplayName(cfg.MODE, leg.side);
        let won = leg.side === 'HIGHER' ? spot < leg.barrier : spot > leg.barrier;
        if (cfg.MODE === 'no-touch') {
          const touched = leg.side === 'HIGHER' ? intraHigh >= leg.barrier : intraLow <= leg.barrier;
          if (touched) won = false;
        }
        if (cfg.MODE === 'no-touch' && !Number.isFinite(intraHigh)) {
          const touched = leg.side === 'HIGHER' ? spot + barRange / 2 >= leg.barrier : spot - barRange / 2 <= leg.barrier;
          if (touched) won = false;
        }
        const profit = won ? leg.payout - leg.stake : -leg.stake;
        updateLeg(leg.side, { status: won ? 'won' : 'lost', resolved: true, liveProfit: profit });
        appendLog('trade-close', 'DRY ' + (won ? 'WIN' : 'LOSS') + ' ' + label + ' ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + ' exit=' + spot.toFixed(this.pipDigits) + ' barrier=' + leg.barrier.toFixed(this.pipDigits));
      }
    }

    const finalPair = state.currentPair;
    if (!finalPair) return null;
    if (!finalPair.tpTriggered) finalPair.exitReason = 'expiry';
    const realised = legProfit(finalPair.higher) + legProfit(finalPair.lower);
    if (!finalPair.higher && !finalPair.lower) return finalisePair();

    const legs = { won: 0, lost: 0 };
    for (const leg of [finalPair.higher, finalPair.lower]) {
      if (!leg) continue;
      if (leg.status === 'won' || leg.status === 'sold') legs.won++;
      else legs.lost++;
    }
    addSessionResult(realised, legs);
    const sessAfter = state.session.totalProfit;
    appendLog('trade-close', 'block ' + timeHM(finalPair.blockStart) + ' realised: ' + (realised >= 0 ? '+' : '') + realised.toFixed(2) + ' (H ' + legProfit(finalPair.higher).toFixed(2) + ' / L ' + legProfit(finalPair.lower).toFixed(2) + ') sess ' + (sessAfter >= 0 ? '+' : '') + sessAfter.toFixed(2));
    const legsStr = finalPair.higher ? finalPair.higher.status + ' ' + (finalPair.higher.liveProfit >= 0 ? '+' : '') + finalPair.higher.liveProfit.toFixed(2) : '—';
    const lowerStr = finalPair.lower ? finalPair.lower.status + ' ' + (finalPair.lower.liveProfit >= 0 ? '+' : '') + finalPair.lower.liveProfit.toFixed(2) : '—';
    if (this.deps.notify) {
      this.deps.notify.sendTradeResult(cfg.SYMBOL, (realised >= 0 ? '+' : '') + realised.toFixed(2), 'H ' + legsStr + ' · L ' + lowerStr, {
        trades: state.session.trades,
        wins: state.session.wins,
        losses: state.session.losses,
        winRate: state.session.trades > 0 ? Math.round((state.session.wins / state.session.trades) * 100) + '%' : '0%',
        netPnl: (state.session.totalProfit >= 0 ? '+' : '') + state.session.totalProfit.toFixed(2),
      });
    }
    return finalisePair();
  }}// ─── Trader ─────────────────────────────────────────────────────────────────────

class Trader {
  constructor() {
    this.cfg = CONFIG;
    this.candles = [];
    this.openContractIds = new Set();
    this.stopped = false;
    this.offFns = [];
    this.pipDigits = 2;
    this.subscribed = false;
    this.ledgerSeeded = false;
    this.dryRunTicks = null;
    this.intraHigh = -Infinity;
    this.intraLow = Infinity;
    this.hourlyTimer = null;
    this.hourlyTradesBase = 0;
    this.eodTimer = null;
    this.telegram = createTelegramNotifier(CONFIG.TELEGRAM_TOKEN, CONFIG.TELEGRAM_CHAT_ID);
    this.ws = new DerivWS({ appId: CONFIG.APP_ID, token: CONFIG.TOKEN, accountId: CONFIG.ACCOUNT_ID, preferAccountType: CONFIG.PREFER });
    this.clock = new BlockClock(blockSeconds());
    this.pair = new PairTrader({
      ws: this.ws,
      cfg: () => this.cfg,
      registerContractId: (id) => this.openContractIds.add(id),
      unregisterContractId: (id) => this.openContractIds.delete(id),
      notify: this.telegram.enabled ? this.telegram : undefined,
    });
  }

  getConfig() { return { ...this.cfg }; }

  patchConfig(patch) {
    Object.assign(this.cfg, patch);
  }async start() {
    appendLog('system', 'HiLo-Fast starting — symbol=' + this.cfg.SYMBOL + ' block=' + this.cfg.BLOCK_MINUTES + 'm stake=' + this.cfg.STAKE + ' blockTP=' + this.cfg.BLOCK_TP + (this.cfg.DRY_RUN ? ' [DRY-RUN]' : ''));
    this.seedDayFromLedger();
    this.loadPersistedState();
    this.evaluateSessionGuards();

    this.wireWsEvents();

    if (this.cfg.DRY_RUN) {
      appendLog('info', 'dry-run — skipping Deriv auth, using synthetic candles');
      await this.bootDryRun();
      this.startDryRunTicks();
      this.subscribed = true;
    } else {
      const account = await this.ws.connect();
      setAccount({ loginid: account.account_id, type: account.account_type, balance: account.balance, currency: account.currency });
      if (!this.cfg.CURRENCY) this.cfg.CURRENCY = account.currency || 'USD';
      appendLog('info', 'connected — ' + account.account_type + ' ' + account.account_id + ' ' + account.currency + ' ' + account.balance.toFixed(2));
      if (!this.cfg.SKIP_CONTRACT_CHECK) await this.verifySymbolSupports();
      await this.ws.subscribeTicks(this.cfg.SYMBOL);
      await this.loadHistoricalCandles();
      await this.subscribeLiveCandles();
      try { await this.ws.subscribeBalance(); } catch (e) { /* best-effort */ }
      this.subscribed = true;
    }

    this.offFns.push(this.clock.on('block-end', (w) => this.onBlockEnd(w)));
    this.offFns.push(this.clock.on('block-start', (w) => this.onBlockStart(w)));
    this.clock.start();

    this.hourlyTradesBase = state.session.trades;
    const msToNextHour = (60 - new Date().getUTCMinutes()) * 60000;
    setTimeout(() => {
      this.sendHourlySummary();
      this.hourlyTimer = setInterval(() => this.sendHourlySummary(), 3600000);
    }, msToNextHour);

    this.scheduleEodSummary();

    const now = this.clock.currentWindow();
    const waitSec = Math.max(0, Math.ceil(now.end - Date.now() / 1000));
    const nextHM = new Date(now.end * 1000).toISOString().slice(11, 16) + 'Z';
    appendLog('info', 'waiting for next block at ' + nextHM + ' (~' + waitSec + 's)');
    if (!state.halted) setStatus('running');
  }

  async stop() {
    this.stopped = true;
    this.clock.stop();
    if (this.dryRunTicks) { clearInterval(this.dryRunTicks); this.dryRunTicks = null; }
    if (this.hourlyTimer) { clearInterval(this.hourlyTimer); this.hourlyTimer = null; }
    if (this.eodTimer) { clearTimeout(this.eodTimer); this.eodTimer = null; }
    const sellPromise = (async () => { try { await this.pair.sellOpenLegs(); } catch (e) { /* noop */ } })();
    const guard = new Promise((resolve) => setTimeout(resolve, 2000));
    await Promise.race([sellPromise, guard]);
    for (const off of this.offFns.splice(0)) { try { off(); } catch (e) { /* noop */ } }
    this.ws.disconnect();
    setStatus('idle');
  }wireWsEvents() {
    this.offFns.push(this.ws.on('tick', (t) => this.onTick(t)));
    this.offFns.push(this.ws.on('ohlc', (o) => this.onOhlc(o)));
    this.offFns.push(this.ws.on('contract', (c) => this.onContract(c)));
    this.offFns.push(this.ws.on('balance', (b) => setAccount({ balance: b.balance, currency: b.currency })));
    this.offFns.push(this.ws.on('status', (s) => appendLog('info', 'ws ' + s)));
    this.offFns.push(this.ws.on('error', (m) => appendLog('error', m)));
    this.offFns.push(this.ws.on('info', (m) => appendLog('info', m)));
    this.offFns.push(this.ws.on('reconnect', () => this.onReconnect()));
  }

  async verifySymbolSupports() {
    const cf = await this.ws.getContractsFor(this.cfg.SYMBOL);
    const needed = this.cfg.MODE === 'no-touch' ? ['NOTOUCH'] : ['HIGHER', 'LOWER'];
    const missing = needed.filter((t) => !cf.contract_types.has(t));
    if (missing.length) {
      const have = [...cf.contract_types].sort().join(', ') || '(none)';
      throw new Error('symbol ' + this.cfg.SYMBOL + ' does not support ' + missing.join(' & ') + '. contracts_for returned: ' + have);
    }
    const pip = cf.pip_size;
    if (pip > 0 && pip < 1) {
      const digits = Math.round(-Math.log10(pip));
      this.pipDigits = digits;
      this.pair.setPipDigits(digits);
    }
    this.pair.setConstraints(cf.constraints);
    for (const t of needed) {
      const c = cf.constraints[t];
      if (c && (c.minDurationSec !== undefined || c.maxDurationSec !== undefined)) {
        appendLog('info', t + ': duration ' + (c.minDurationSec ?? '?') + 's..' + (c.maxDurationSec ?? '?') + 's');
      }
    }
  }

  async loadHistoricalCandles() {
    const blockSec = blockSeconds();
    const bars = Math.ceil(86400 / blockSec) * (this.cfg.LOOKBACK_DAYS + 2);
    try {
      this.candles = await this.ws.fetchCandlesHistory(this.cfg.SYMBOL, blockSec, bars);
      appendLog('info', 'loaded ' + this.candles.length + ' candles @ ' + blockSec + 's granularity');
    } catch (err) {
      appendLog('warn', 'candle history fetch failed: ' + (err.message || String(err)));
    }
  }

  async subscribeLiveCandles() {
    try {
      await this.ws.getCandles(this.cfg.SYMBOL, blockSeconds(), 1, true);
    } catch (err) {
      appendLog('warn', 'candle subscribe failed: ' + (err.message || String(err)));
    }
  }async bootDryRun() {
    const blockSec = blockSeconds();
    const now = Math.floor(Date.now() / 1000);
    const barsPerDay = Math.ceil(86400 / blockSec);
    const n = Math.min(5000, barsPerDay * (this.cfg.LOOKBACK_DAYS + 2));
    const start = Math.floor(now / blockSec) * blockSec - blockSec * n;
    let price = 1000;
    const out = [];
    for (let i = 0; i < n; i++) {
      const open = price;
      const drift = (Math.random() - 0.5) * 0.4;
      const range = 0.3 + Math.random() * 0.7;
      const high = open + range;
      const low = open - range;
      const close = open + drift + (Math.random() - 0.5) * range;
      out.push({ epoch: start + i * blockSec, open: open, high: high, low: low, close: close });
      price = close;
    }
    this.candles = out;
    setSpot(price);
    setAccount({ type: 'demo', balance: 10000, currency: 'USD' });
    if (!this.cfg.CURRENCY) this.cfg.CURRENCY = 'USD';
    appendLog('info', 'dry-run synthetic candles: ' + out.length + ' @ ' + blockSec + 's');
  }

  startDryRunTicks() {
    if (this.dryRunTicks) clearInterval(this.dryRunTicks);
    let price = state.lastSpot ?? (this.candles[this.candles.length - 1] ? this.candles[this.candles.length - 1].close : 1000);
    setSpot(price);
    this.dryRunTicks = setInterval(() => {
      if (this.stopped) return;
      const last = this.candles[this.candles.length - 1];
      const range = last ? last.high - last.low : 1;
      const sigma = range / 4 / Math.sqrt(Math.max(1, this.cfg.BLOCK_MINUTES * 60));
      const drift = (Math.random() - 0.5) * sigma;
      price = Math.max(0.01, price + drift);
      setSpot(price);
      if (price > this.intraHigh) this.intraHigh = price;
      if (price < this.intraLow) this.intraLow = price;
      const pair = state.currentPair;
      if (pair) this.pair.markToMarket(price, pair.blockEnd);
    }, 1000);
  }

  onTick(t) {
    if (t.symbol !== this.cfg.SYMBOL) return;
    setSpot(t.quote);
    if (this.cfg.DRY_RUN) {
      if (t.quote > this.intraHigh) this.intraHigh = t.quote;
      if (t.quote < this.intraLow) this.intraLow = t.quote;
    }
  }

  onOhlc(o) {
    if (o.symbol !== this.cfg.SYMBOL) return;
    const last = this.candles[this.candles.length - 1];
    const bar = { epoch: o.epoch, open: o.open, high: o.high, low: o.low, close: o.close };
    if (last && last.epoch === bar.epoch) {
      this.candles[this.candles.length - 1] = bar;
    } else {
      this.candles.push(bar);
      if (this.candles.length > 6000) this.candles.splice(0, this.candles.length - 5000);
    }
  }

  onContract(u) {
    this.pair.onContractUpdate(u);
    this.evaluateSessionGuards();
  }

  onReconnect() {
    appendLog('info', 'resubscribing after reconnect');
    this.subscribed = false;
    void (async () => {
      try {
        await this.ws.subscribeTicks(this.cfg.SYMBOL);
        await this.subscribeLiveCandles();
        await this.loadHistoricalCandles();
        try { await this.ws.subscribeBalance(); } catch (e2) { /* best-effort */ }
        for (const id of this.openContractIds) {
          try { await this.ws.subscribeOpenContract(id); } catch (e3) { /* ignore */ }
        }
        this.subscribed = true;
        appendLog('info', 'reconnected — ' + this.candles.length + ' candles reloaded');
      } catch (err) {
        appendLog('error', 'resubscribe failed: ' + (err.message || String(err)));
      }
    })();
  }async onBlockStart(w) {
    if (this.stopped) return;
    if (state.halted) return;
    if (!this.subscribed) {
      appendLog('warn', 'block ' + new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z — subscriptions not ready, skipping');
      return;
    }

    // Trade gate: skip if previous pair still has live (unresolved) legs.
    const prevPair = state.currentPair;
    if (prevPair && (prevPair.higher || prevPair.lower)) {
      const prevOpen = [prevPair.higher, prevPair.lower].filter(l => l && !l.resolved);
      if (prevOpen.length > 0) {
        appendLog('warn', 'block ' + new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z — previous pair still has ' + prevOpen.length + ' live leg(s), skipping');
        return;
      }
    }

    // Trade gate: skip if insufficient time for any contract.
    const nowSec = Date.now() / 1000;
    const durationSec = Math.max(0, Math.floor(w.end - nowSec));
    if (durationSec < 15) {
      appendLog('warn', 'block ' + new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z — only ' + durationSec + 's left, skipping pair');
      return;
    }

    const spot = state.lastSpot ?? (this.candles.length ? this.candles[this.candles.length - 1].close : 0);
    this.intraHigh = spot;
    this.intraLow = spot;
    const granularity = blockSeconds();
    const hh = new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z';

    // Martingale: if enabled, increase stake based on consecutive losses.
    // Respects HILO_MARTINGALE_STEPS — caps exponent and resets cycle after limit.
    let effectiveStake = this.cfg.STAKE;
    if (this.cfg.MARTINGALE_ENABLED) {
      let consecutiveLosses = state.session.consecutiveLosses;
      // Respect STEPS: if exceeded limit, reset cycle to base (prevents infinite growth and halt)
      if (this.cfg.MARTINGALE_STEPS > 0 && consecutiveLosses > this.cfg.MARTINGALE_STEPS) {
        appendLog('info', 'martingale: steps limit ' + this.cfg.MARTINGALE_STEPS + ' exceeded (' + consecutiveLosses + ' losses) — resetting to base stake ' + this.cfg.STAKE.toFixed(2));
        state.session.consecutiveLosses = 0;
        consecutiveLosses = 0;
        saveState(this.cfg.STATE_PATH, state.session);
      }
      const losses = Math.min(consecutiveLosses, this.cfg.MARTINGALE_STEPS);
      if (losses > 0) {
        effectiveStake = this.cfg.STAKE * Math.pow(this.cfg.MARTINGALE_MULTIPLIER, losses);
        appendLog('info', 'martingale: losses=' + consecutiveLosses + ' capped=' + losses + ' stake=' + this.cfg.STAKE.toFixed(2) + '->' + effectiveStake.toFixed(2) + ' (x' + this.cfg.MARTINGALE_MULTIPLIER + '^' + losses + ')');
      } else {
        appendLog('info', 'martingale: losses=' + consecutiveLosses + ' — using base stake ' + effectiveStake.toFixed(2));
      }
    }

    if (this.cfg.EV_MODE) {
      const quote = this.makeBandQuote();
      const sel = await selectBand({
        candles: this.candles,
        blockStart: w.start,
        blockEnd: w.end,
        spot: spot,
        mode: this.cfg.MODE,
        kCandidates: this.cfg.K_CANDIDATES,
        minEv: this.cfg.MIN_EV,
        lookbackDays: this.cfg.LOOKBACK_DAYS,
        regime: regimeFromConfig(this.cfg),
        quote,
      });
      if (!sel) {
        appendLog('warn', 'block ' + hh + ' — no same-TOD history for EV estimation — skipping');
        return;
      }
      const best = sel.best;
      if (best) {
        const evB = best.evBlock;
        appendLog('info', 'EV scan: K=' + best.k.toFixed(2) + ' -> ev ' + (evB >= 0 ? '+' : '') + evB.toFixed(2) + ' (payouts up ' + (best.payoutUp ? best.payoutUp.toFixed(2) : '–') + ' dn ' + (best.payoutDn ? best.payoutDn.toFixed(2) : '–') + ' · best over ' + sel.candidates.length + ' K values)');
      }
      if (sel.selectedK === null) {
        appendLog('warn', 'block ' + hh + ' — best combined EV below ' + this.cfg.MIN_EV.toFixed(2) + ' — skipping');
        return;
      }
      const chosen = sel.best;
      const edges = {
        HIGHER: chosen.truePUp - (chosen.impliedPUp ?? chosen.truePUp),
        LOWER: chosen.truePDn - (chosen.impliedPDn ?? chosen.truePDn),
      };
      await this.pair.openPair({
        blockStart: w.start,
        blockEnd: w.end,
        blockOpen: spot,
        predictedHigh: chosen.predHigh,
        predictedLow: chosen.predLow,
        predictionSource: 'historical',
        daysUsed: sel.model.daysUsed,
        spot: spot,
        evK: chosen.k,
        model: sel.model,
        edges: edges,
        effectiveStake: effectiveStake,
        tradeDirection: this.cfg.TRADE_DIRECTION,
      });
      return;
    }

    // Legacy path: fixed-K band from the range predictor.
    const pred = predictRange(this.candles, w.start, w.end, spot, {
      mode: this.cfg.RANGE_MODE,
      lookbackDays: this.cfg.LOOKBACK_DAYS,
      atrBars: this.cfg.ATR_BARS,
      k: this.cfg.RANGE_K,
      granularitySec: granularity,
      regime: regimeFromConfig(this.cfg),
    });
    if (!pred) {
      appendLog('warn', 'block ' + hh + ' — no prediction (need more history) — skipping');
      return;
    }

    // Apply barrier floor to legacy predictions too.
    const flooredLegacy = enforceBarrierFloor(spot, pred.predictedHigh, pred.predictedLow, null, this.pipDigits);
    if (flooredLegacy.adjusted) {
      appendLog('info', 'legacy barrier floor — predH ' + pred.predictedHigh.toFixed(this.pipDigits) + '->' + flooredLegacy.predHigh.toFixed(this.pipDigits) + ' predL ' + pred.predictedLow.toFixed(this.pipDigits) + '->' + flooredLegacy.predLow.toFixed(this.pipDigits));
    }

    let model = null;
    if (pred.meanUp !== undefined && pred.meanDown !== undefined) {
      model = winRateModelFromMeans(pred.meanUp, pred.meanDown, granularity, pred.daysUsed);
    }

    await this.pair.openPair({
      blockStart: w.start,
      blockEnd: w.end,
      blockOpen: pred.blockOpen,
      predictedHigh: flooredLegacy.predHigh,
      predictedLow: flooredLegacy.predLow,
      predictionSource: pred.source,
      daysUsed: pred.daysUsed,
      spot: spot,
      model: model,
      effectiveStake: effectiveStake,
      tradeDirection: this.cfg.TRADE_DIRECTION,
    });
  }

  onBlockEnd(w) {
    console.log('[TRACE] onBlockEnd called, STATE_PATH=' + this.cfg.STATE_PATH + ' DEBUG=' + CONFIG.DEBUG_MODE);
    const spot = state.lastSpot ?? (this.candles.length ? this.candles[this.candles.length - 1].close : 0);
    const bar = this.candles.find((c) => c.epoch === w.start);
    const range = bar ? bar.high - bar.low : 0;
    const pair = this.pair.realiseAtBlockEnd(spot, this.intraHigh, this.intraLow, range);
    if (pair) this.recordLedgerRow(pair, w);
    LOGGER.debug('about to save state, path=' + this.cfg.STATE_PATH);
    this.savePersistedState();
    LOGGER.debug('state save done');
    this.evaluateSessionGuards();
  }

  makeBandQuote() {
    const bar = (price) => price.toFixed(this.pipDigits);
    return async (req) => {
      if (this.cfg.DRY_RUN) {
        const sim = simulateQuote({
          trueP: req.trueP, distance: req.distance, sigmaBlock: req.sigmaBlock,
          mode: this.cfg.MODE, edge: this.cfg.DRY_RUN_EDGE ?? 0, stake: this.cfg.STAKE,
        });
        return sim;
      }
      const contractType = contractTypeFor(this.cfg.MODE, req.side);
      const duration = contractType === 'NOTOUCH'
        ? { duration: this.cfg.BLOCK_MINUTES, duration_unit: 'm' }
        : { duration: req.durationSec, duration_unit: 's' };
      try {
        const p = await this.ws.getProposal({
          amount: this.cfg.STAKE,
          currency: this.cfg.CURRENCY,
          contract_type: contractType,
          duration: duration.duration,
          duration_unit: duration.duration_unit,
          symbol: this.cfg.SYMBOL,
          barrier: bar(req.barrier),
        });
        if (!(p.payout > 0) || p.impliedP === undefined) return null;
        return { payout: p.payout, impliedP: p.impliedP };
      } catch (err) {
        return null;
      }
    };
  }

  recordLedgerRow(pair, w) {
    if (!this.cfg.LEDGER_PATH) return;
    const pnlUp = pair.higher ? pair.higher.liveProfit : 0;
    const pnlDn = pair.lower ? pair.lower.liveProfit : 0;
    const row = {
      at: w.start,
      block: new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z',
      mode: this.cfg.MODE,
      source: pair.predictionSource,
      daysUsed: pair.daysUsed,
      evK: pair.evK,
      open: pair.blockOpen,
      predH: pair.predictedHigh,
      predL: pair.predictedLow,
      exit: pair.exitReason ?? 'expiry',
      pnlUp: pnlUp,
      pnlDn: pnlDn,
      pnlBlock: pnlUp + pnlDn,
      sessionPnl: state.session.totalProfit,
    };
    try {
      appendLedgerRow(this.cfg.LEDGER_PATH, row);
    } catch (err) {
      appendLog('warn', 'ledger write failed: ' + (err.message || String(err)));
    }
  }

  evaluateSessionGuards() {
    if (state.halted) return;
    const st = state.session;
    const p = st.totalProfit;
    let reason = '';
    if (this.cfg.SESSION_TP !== undefined && p >= this.cfg.SESSION_TP) {
      reason = 'session TP hit: ' + p.toFixed(2) + ' >= ' + this.cfg.SESSION_TP;
    } else if (this.cfg.SESSION_SL !== undefined && p <= -this.cfg.SESSION_SL) {
      reason = 'session SL hit: ' + p.toFixed(2) + ' <= -' + this.cfg.SESSION_SL;
    } else if ((this.cfg.MAX_CONSECUTIVE_LOSSES ?? 0) > 0 && st.consecutiveLosses >= this.cfg.MAX_CONSECUTIVE_LOSSES) {
      // When Martingale is enabled, respect HILO_MARTINGALE_STEPS — don't halt while within martingale cycle
      const inMartingaleCycle = this.cfg.MARTINGALE_ENABLED && st.consecutiveLosses <= this.cfg.MARTINGALE_STEPS;
      if (!inMartingaleCycle) {
        reason = 'circuit-breaker: ' + st.consecutiveLosses + ' consecutive losses (max ' + this.cfg.MAX_CONSECUTIVE_LOSSES + ')';
      }
    } else if ((this.cfg.DAILY_LOSS_CAP ?? 0) > 0 && st.dayProfit <= -this.cfg.DAILY_LOSS_CAP) {
      reason = 'daily loss cap: today ' + st.dayProfit.toFixed(2) + ' <= -' + this.cfg.DAILY_LOSS_CAP;
    }
    if (reason) {
      halt(reason);
      appendLog('system', 'halted — ' + reason);
      const wr = st.trades > 0 ? Math.round((st.wins / st.trades) * 100) + '%' : '0%';
      this.telegram.sendSessionEnd(
        this.cfg.SYMBOL, st.trades,
        (p >= 0 ? '+' : '') + p.toFixed(2),
        wr,
        reason
      );
    }
  }

  sendHourlySummary() {
    const st = state.session;
    const trades = st.trades - this.hourlyTradesBase;
    if (trades <= 0) return;
    const pnl = st.totalProfit;
    const wr = st.trades > 0 ? Math.round((st.wins / st.trades) * 100) + '%' : '0%';
    this.telegram.sendHourly(
      this.cfg.SYMBOL, trades,
      (pnl >= 0 ? '+' : '') + pnl.toFixed(2),
      wr,
      { totalTrades: st.trades, wins: st.wins, losses: st.losses, netPnl: (pnl >= 0 ? '+' : '') + pnl.toFixed(2) }
    );
    this.hourlyTradesBase = st.trades;
  }

  seedDayFromLedger() {
    if (this.ledgerSeeded || !this.cfg.LEDGER_PATH) return;
    this.ledgerSeeded = true;
    try {
      const rows = loadLedger(this.cfg.LEDGER_PATH);
      if (rows.length === 0) return;
      const dayKey = new Date().toISOString().slice(0, 10);
      const dayPnl = ledgerDayPnl(rows, dayKey);
      setSessionDay(dayPnl, dayKey);
      appendLog('info', 'ledger: ' + rows.length + ' rows · today ' + (dayPnl >= 0 ? '+' : '') + dayPnl.toFixed(2) + ' (' + dayKey + ')');
    } catch (err) {
      appendLog('warn', 'ledger seed failed: ' + (err.message || String(err)));
    }
  }

  loadPersistedState() {
    if (!this.cfg.STATE_PATH) return;
    const restored = loadState(this.cfg.STATE_PATH);
    if (!restored) return;
    restoreSession(restored);
    appendLog('info', 'state restored — ' + restored.trades + ' trades, ' + restored.wins + 'W/' + restored.losses + 'L, P/L ' + ((restored.totalProfit ?? 0) >= 0 ? '+' : '') + (restored.totalProfit ?? 0).toFixed(2) + ' (' + (restored.dayKey || '') + ')');
  }

  savePersistedState() {
    if (!this.cfg.STATE_PATH) return;
    try {
      saveState(this.cfg.STATE_PATH, state.session);
      LOGGER.debug('state saved to ' + this.cfg.STATE_PATH);
    } catch (err) {
      LOGGER.error('savePersistedState failed: ' + (err.message || String(err)));
    }
  }

  scheduleEodSummary() {
    if (this.eodTimer) clearTimeout(this.eodTimer);
    const now = new Date();
    const gmt1 = new Date(now.getTime() + 3600000);
    const target = new Date(gmt1);
    target.setUTCHours(23, 0, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    const msUntil = target.getTime() - now.getTime();
    this.eodTimer = setTimeout(() => {
      this.sendEndOfDaySummary();
      this.scheduleEodSummary();
    }, msUntil);
  }

  sendEndOfDaySummary() {
    const s = state.session;
    const dateStr = new Date(Date.now() - 3600000).toISOString().slice(0, 10);
    const winRate = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) + '%' : '0%';
    this.telegram.sendEndOfDay(this.cfg.SYMBOL, dateStr, {
      trades: s.trades, wins: s.wins, losses: s.losses,
      winRate: winRate,
      netPnl: (s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2),
    });
    appendLog('info', 'end-of-day summary sent (' + dateStr + ' GMT+1)');
  }
}// ─── Initialization ──────────────────────────────────────────────────────────────

async function main() {
  const { help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write('HiLo-Fast — time-block paired Deriv contracts (stay-in-range, EV-first)\n\n');
    process.exit(0);
  }
  if (version) {
    process.stdout.write('hilo-fast-bot.js v1.0.0\n');
    process.exit(0);
  }

  // Validate block granularity.
  try {
    assertBlockGranularity(CONFIG.BLOCK_MINUTES);
  } catch (err) {
    process.stderr.write('hilo-fast: ' + err.message + '\n');
    process.exit(2);
  }

  if (!CONFIG.DRY_RUN && !CONFIG.TOKEN) {
    process.stderr.write('hilo-fast: --token or DERIV_TOKEN is required for live trading\n');
    process.exit(2);
  }

  // Reload CONFIG values that may have been patched by parseArgs into the trader's cfg copy
  // (the Trader constructor captures CONFIG by reference, so this is automatic)

  const trader = new Trader();

  // Graceful shutdown.
  async function shutdown(sig) {
    appendLog('system', 'received ' + sig + ' — shutting down');
    try {
      await trader.stop();
    } catch (err) {
      appendLog('error', 'stop failed: ' + (err.message || String(err)));
    }
    try {
      if (trader.cfg.LEDGER_PATH) saveState(trader.cfg.STATE_PATH, state.session);
    } catch (e) { /* best-effort */ }
    setTimeout(() => process.exit(0), 500);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    LOGGER.error('UNCAUGHT: ' + err.message + '\n' + (err.stack || ''));
    try { saveState(trader.cfg.STATE_PATH, state.session); } catch (e) { /* ignore */ }
  });
  process.on('unhandledRejection', (reason) => {
    LOGGER.error('UNHANDLED: ' + (reason && reason.message ? reason.message : String(reason)));
    try { saveState(trader.cfg.STATE_PATH, state.session); } catch (e) { /* ignore */ }
  });

  // Status display every 60s.
  setInterval(() => {
    const s = state.session;
    const wr = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) + '%' : '0%';
    const pnlStr = (s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2);
    LOGGER.info(`Session: ${s.trades}t ${wr} ${pnlStr} | consec ${s.consecutiveLosses} | day ${(s.dayProfit >= 0 ? '+' : '')}${s.dayProfit.toFixed(2)}`);
  }, 60000);

  try {
    await trader.start();
  } catch (err) {
    LOGGER.error('startup failed: ' + (err.message || String(err)) + '\n' + (err.stack || ''));
    try { await trader.stop(); } catch (e) { /* ignore */ }
    process.exit(1);
  }
}

void main();
