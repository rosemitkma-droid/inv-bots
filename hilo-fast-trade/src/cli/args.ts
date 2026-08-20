import {
  ALLOWED_CANDLE_GRANULARITIES,
  DEFAULT_APP_ID,
  DEFAULT_BACKTEST_EDGE,
  DEFAULT_ATR_BARS,
  DEFAULT_BLOCK_MINUTES,
  DEFAULT_BLOCK_SL,
  DEFAULT_BLOCK_TP,
  DEFAULT_BLOCK_TRAIL,
  DEFAULT_DAILY_LOSS_CAP,
  DEFAULT_DRY_RUN_EDGE,
  DEFAULT_EV_MODE,
  DEFAULT_EV_STAGGER,
  DEFAULT_K_CANDIDATES,
  DEFAULT_LEDGER_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MAX_CONSECUTIVE_LOSSES,
  DEFAULT_MIN_EV,
  DEFAULT_RANGE_K,
  DEFAULT_RANGE_MODE,
  DEFAULT_REGIME_BARS,
  DEFAULT_REGIME_BLEND,
  DEFAULT_SESSION_SL,
  DEFAULT_SESSION_TP,
  DEFAULT_STAKE,
  DEFAULT_SYMBOL,
  DEFAULT_TRADE_MODE,
  DEFAULT_TRADE_DIRECTION,
  DEFAULT_MARTINGALE_ENABLED,
  DEFAULT_MARTINGALE_MULTIPLIER,
  DEFAULT_MARTINGALE_STEPS,
  DEFAULT_TRAIL_ARM_FRACTION,
} from '../constants/api';
import type { RangeMode } from '../engine/rangePredictor';
import type { HiLoConfig, TradeMode, TradeDirection } from '../trading/config';

export interface ParsedArgs {
  cfg: HiLoConfig;
  help: boolean;
  version: boolean;
}

const HELP_TEXT = `
HiLo-Fast — time-block paired Deriv contracts (stay-in-range, EV-first)

Usage:
  bun src/index.ts [flags]

Required:
  --token <t>               Deriv API / OAuth token (or env DERIV_TOKEN)

Market:
  --symbol <sym>            underlying symbol (default ${DEFAULT_SYMBOL})
  --stake <usd>             per-leg stake (default ${DEFAULT_STAKE})
  --currency <c>            currency override (default: account currency)

Block grid:
  --block-minutes <n>       block size in minutes (default ${DEFAULT_BLOCK_MINUTES})
  --block-tp <usd>          sell pair when combined live P/L >= this (default ${DEFAULT_BLOCK_TP})
  --block-sl <usd>          sell pair when combined live P/L <= -this (default ${DEFAULT_BLOCK_SL || 'off'})
  --block-trail <usd>       sell pair when P/L retraces this far below its intrabar peak
                           (default ${DEFAULT_BLOCK_TRAIL || 'off'}; arms once the peak reaches
                            ${Math.round(DEFAULT_TRAIL_ARM_FRACTION * 100)}% of --block-tp)
  --session-tp <usd>        halt when session P/L >= this (default ${DEFAULT_SESSION_TP})
  --session-sl <usd>        halt when session P/L <= -this (default ${DEFAULT_SESSION_SL})

Trade primitive:
  --mode <higher-lower|no-touch>   contract type per leg (default ${DEFAULT_TRADE_MODE})

Prediction:
  --range-mode <m>          hybrid | historical | atr (default ${DEFAULT_RANGE_MODE})
  --lookback-days <n>       same-TOD lookback (default ${DEFAULT_LOOKBACK_DAYS})
  --atr-bars <n>            ATR window for fallback (default ${DEFAULT_ATR_BARS})
  --range-k <x>             extension multiplier (default ${DEFAULT_RANGE_K})
  --regime-bars <n>         recent-vol window for the regime blend, in block-windows
                           (default ${DEFAULT_REGIME_BARS})
  --regime-blend <x>        blend recent realized vol into the same-TOD model mean:
                           0 = off, 1 = recent vol alone. Start at 0.2 for live trading
                           to keep the model honest during vol spikes.

EV-first band selection (Phase 1 — ON by default):
  --no-ev-mode              disable EV selection, fall back to fixed-K band
  --ev-mode                 quote candidate K values, pick the highest-EV band,
                           skip blocks below --min-ev (default on)
  --k-candidates <a,b,…>    K grid for the selector (default ${DEFAULT_K_CANDIDATES.join(',')})
  --min-ev <usd>            skip a block unless best combined EV >= this (default ${DEFAULT_MIN_EV})
  --dry-run-edge <x>        simulated house vol premium in dry-run (default ${DEFAULT_DRY_RUN_EDGE})
  --no-ev-stagger           disable edge-scaled per-leg stake
  --ev-stagger              size each leg by its edge: stake × clamp(1 + 2·(trueP−impliedP))
                           (default on)

Trade direction:
  --trade-direction <mode>  both (open upper+lower, default) or positive-ev
                           (only open legs with positive EV; skip leg if EV <= 0)
                           (default ${DEFAULT_TRADE_DIRECTION}, or env HILO_TRADE_DIRECTION)

Martingale stake sizing (OFF by default):
  --martingale              enable martingale stake multiplier after losses (env HILO_MARTINGALE_ENABLED)
  --no-martingale           disable martingale
  --martingale-multiplier <x>  stake multiplier per losing step (default ${DEFAULT_MARTINGALE_MULTIPLIER})
  --martingale-steps <n>    max consecutive losing steps before reset (default ${DEFAULT_MARTINGALE_STEPS})

Survival & measurement (Phase 3):
  --ledger <path>           append each realised block as a CSV row; seed today's P&L at
                           boot (default: off)
  --max-losses <n>          halt after n consecutive losing blocks (default ${DEFAULT_MAX_CONSECUTIVE_LOSSES})
  --daily-loss-cap <usd>    halt when today's realised P&L <= -this (default ${DEFAULT_DAILY_LOSS_CAP})
  --backtest                replay candle history block-by-block, print win rate / P&L /
                           expectancy, then exit. No auth, no trading. Candles come from
                           --csv when given, else live Deriv (--token required).
  --backtest-edge <x>       simulated house vol premium for the backtest's leg quotes
                           (default ${DEFAULT_BACKTEST_EDGE}: fair house)
  --csv <path>              OHLC CSV (epoch,open,high,low,close) for the backtest. When
                           omitted, --backtest pulls live history via Deriv (--token).

Telegram notifications (optional — both required):
  --telegram-token <t>      Telegram bot token (from @BotFather) (or env TELEGRAM_BOT_TOKEN)
  --telegram-chat-id <id>   Telegram chat/user ID to receive notifications (or env TELEGRAM_CHAT_ID)

State persistence (optional):
  --state-path <path>       JSON file for session stats (default .hilo_state.json,
                            or env HILO_STATE_PATH). Survives reconnects / restarts.

Account:
  --account-id <id>         pin to a specific Deriv account
  --prefer <demo|real>      prefer demo or real when multiple active (default demo)

Modes:
  --dry-run                 synthetic candles, simulated buys/sells — no network trades
  --skip-contract-check     skip contracts_for verification (debug only)
  --no-ui                   plain console output instead of the Ink TUI
  --app-id <id>             Deriv app id (default bundled)

Misc:
  --help                    this message
  --version                 print version
`;

function usage(): string {
  return HELP_TEXT.trim();
}

function err(msg: string): never {
  process.stderr.write(`hilo-fast: ${msg}\n\n${usage()}\n`);
  process.exit(2);
}

function numArg(v: string | undefined, name: string): number {
  if (v === undefined) err(`--${name} requires a value`);
  const n = Number(v);
  if (!Number.isFinite(n)) err(`--${name} must be a number (got '${v}')`);
  return n;
}

function str(v: string | undefined, name: string): string {
  if (v === undefined || v === '') err(`--${name} requires a value`);
  return v;
}

function rangeMode(v: string | undefined): RangeMode {
  if (v === undefined) err(`--range-mode requires a value`);
  const lc = v.toLowerCase();
  if (lc === 'h' || lc === 'hybrid') return 'hybrid';
  if (lc === 'hist' || lc === 'historical') return 'historical';
  if (lc === 'atr') return 'atr';
  err(`--range-mode must be one of: hybrid, historical, atr (got '${v}')`);
}

function tradeMode(v: string | undefined): TradeMode {
  if (v === undefined) err(`--mode requires a value`);
  const lc = v.toLowerCase();
  if (lc === 'higher-lower' || lc === 'hl' || lc === 'higherlower') return 'higher-lower';
  if (lc === 'no-touch' || lc === 'nt' || lc === 'notouch') return 'no-touch';
  err(`--mode must be one of: higher-lower, no-touch (got '${v}')`);
}

function envTradeMode(name: string, fallback: TradeMode): TradeMode {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'higher-lower' || raw === 'hl' || raw === 'higherlower') return 'higher-lower';
  if (raw === 'no-touch' || raw === 'nt' || raw === 'notouch') return 'no-touch';
  return fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envOptNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envRangeMode(name: string, fallback: RangeMode): RangeMode {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'h' || raw === 'hybrid') return 'hybrid';
  if (raw === 'hist' || raw === 'historical') return 'historical';
  if (raw === 'atr') return 'atr';
  return fallback;
}

function envPrefer(name: string): 'demo' | 'real' {
  const raw = process.env[name]?.toLowerCase();
  return raw === 'real' ? 'real' : 'demo';
}

function envTradeDirection(name: string, fallback: TradeDirection): TradeDirection {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'positive-ev' || raw === 'positiveev' || raw === 'positive' || raw === 'single') return 'positive-ev';
  return 'both';
}

function tradeDirectionArg(v: string | undefined): TradeDirection {
  if (v === undefined) err('--trade-direction requires a value');
  const lc = v.toLowerCase();
  if (lc === 'both') return 'both';
  if (lc === 'positive-ev' || lc === 'positiveev' || lc === 'positive' || lc === 'single') return 'positive-ev';
  err(`--trade-direction must be one of: both, positive-ev (got '${v}')`);
}

/** Parse a comma-separated K grid from env, fall back to the default. */
function envKList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const out = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return out.length ? out : fallback;
}

/** Parse a comma-separated K grid from a CLI arg. Throws on garbage. */
function kListArg(v: string | undefined): number[] {
  if (v === undefined) err('--k-candidates requires a comma-separated list of positive numbers');
  const out = v
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (out.length === 0) err(`--k-candidates: '${v}' has no positive numbers`);
  return out;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const cfg: HiLoConfig = {
    appId: process.env.DERIV_APP_ID || DEFAULT_APP_ID,
    token: process.env.DERIV_TOKEN || '',
    accountId: process.env.DERIV_ACCOUNT_ID || undefined,
    preferAccountType: envPrefer('HILO_PREFER'),
    symbol: process.env.HILO_SYMBOL || DEFAULT_SYMBOL,
    currency: process.env.HILO_CURRENCY || '',
    stake: envNum('HILO_STAKE', DEFAULT_STAKE),
    blockMinutes: envNum('HILO_BLOCK_MINUTES', DEFAULT_BLOCK_MINUTES),
    mode: envTradeMode('HILO_TRADE_MODE', DEFAULT_TRADE_MODE),
    blockTp: envNum('HILO_BLOCK_TP', DEFAULT_BLOCK_TP),
    blockSl: envNum('HILO_BLOCK_SL', DEFAULT_BLOCK_SL),
    blockTrail: envNum('HILO_BLOCK_TRAIL', DEFAULT_BLOCK_TRAIL),
    sessionTp: envNum('HILO_SESSION_TP', DEFAULT_SESSION_TP),
    sessionSl: envNum('HILO_SESSION_SL', DEFAULT_SESSION_SL),
    rangeMode: envRangeMode('HILO_RANGE_MODE', DEFAULT_RANGE_MODE),
    lookbackDays: envNum('HILO_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS),
    atrBars: envNum('HILO_ATR_BARS', DEFAULT_ATR_BARS),
    rangeK: envNum('HILO_RANGE_K', DEFAULT_RANGE_K),
    regimeBars: envNum('HILO_REGIME_BARS', DEFAULT_REGIME_BARS),
    regimeBlend: envNum('HILO_REGIME_BLEND', DEFAULT_REGIME_BLEND),
    evMode: process.env.HILO_EV_MODE === '1' || process.env.HILO_EV_MODE === 'true',
    kCandidates: envKList('HILO_K_CANDIDATES', DEFAULT_K_CANDIDATES),
    minEv: envNum('HILO_MIN_EV', DEFAULT_MIN_EV),
    dryRunEdge: envNum('HILO_DRY_RUN_EDGE', DEFAULT_DRY_RUN_EDGE),
    evStagger: process.env.HILO_EV_STAGGER === '1' || process.env.HILO_EV_STAGGER === 'true',
    tradeDirection: envTradeDirection('HILO_TRADE_DIRECTION', DEFAULT_TRADE_DIRECTION),
    martingaleEnabled: process.env.HILO_MARTINGALE_ENABLED === '1' || process.env.HILO_MARTINGALE_ENABLED === 'true',
    martingaleMultiplier: envNum('HILO_MARTINGALE_MULTIPLIER', DEFAULT_MARTINGALE_MULTIPLIER),
    martingaleSteps: envNum('HILO_MARTINGALE_STEPS', DEFAULT_MARTINGALE_STEPS),
    ledgerPath: process.env.HILO_LEDGER || DEFAULT_LEDGER_PATH,
    maxConsecutiveLosses: envNum('HILO_MAX_LOSSES', DEFAULT_MAX_CONSECUTIVE_LOSSES),
    dailyLossCap: envNum('HILO_DAILY_LOSS_CAP', DEFAULT_DAILY_LOSS_CAP),
    backtestEdge: envNum('HILO_BACKTEST_EDGE', DEFAULT_BACKTEST_EDGE),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    statePath: process.env.HILO_STATE_PATH || DEFAULT_STATE_PATH,
    backtest: false,
    dryRun: false,
    skipContractCheck: false,
    noUi: false,
  };

  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const nxt = argv[i + 1];
    switch (a) {
      case '--help':
      case '-h': help = true; break;
      case '--version':
      case '-v': version = true; break;
      case '--token': cfg.token = str(nxt, 'token'); i++; break;
      case '--app-id': cfg.appId = str(nxt, 'app-id'); i++; break;
      case '--account-id': cfg.accountId = str(nxt, 'account-id'); i++; break;
      case '--prefer': {
        const v = str(nxt, 'prefer').toLowerCase();
        if (v !== 'demo' && v !== 'real') err(`--prefer must be 'demo' or 'real'`);
        cfg.preferAccountType = v;
        i++;
        break;
      }
      case '--symbol': cfg.symbol = str(nxt, 'symbol'); i++; break;
      case '--currency': cfg.currency = str(nxt, 'currency'); i++; break;
      case '--stake': cfg.stake = numArg(nxt, 'stake'); i++; break;
      case '--block-minutes': cfg.blockMinutes = numArg(nxt, 'block-minutes'); i++; break;
      case '--mode': cfg.mode = tradeMode(nxt); i++; break;
      case '--block-tp': cfg.blockTp = numArg(nxt, 'block-tp'); i++; break;
      case '--block-sl': cfg.blockSl = numArg(nxt, 'block-sl'); i++; break;
      case '--block-trail': cfg.blockTrail = numArg(nxt, 'block-trail'); i++; break;
      case '--session-tp': cfg.sessionTp = numArg(nxt, 'session-tp'); i++; break;
      case '--session-sl': cfg.sessionSl = numArg(nxt, 'session-sl'); i++; break;
      case '--range-mode': cfg.rangeMode = rangeMode(nxt); i++; break;
      case '--lookback-days': cfg.lookbackDays = numArg(nxt, 'lookback-days'); i++; break;
      case '--atr-bars': cfg.atrBars = numArg(nxt, 'atr-bars'); i++; break;
      case '--range-k': cfg.rangeK = numArg(nxt, 'range-k'); i++; break;
      case '--regime-bars': cfg.regimeBars = numArg(nxt, 'regime-bars'); i++; break;
      case '--regime-blend': cfg.regimeBlend = numArg(nxt, 'regime-blend'); i++; break;
      case '--ev-mode': cfg.evMode = true; break;
      case '--k-candidates': cfg.kCandidates = kListArg(nxt); i++; break;
      case '--min-ev': cfg.minEv = numArg(nxt, 'min-ev'); i++; break;
      case '--dry-run-edge': cfg.dryRunEdge = numArg(nxt, 'dry-run-edge'); i++; break;
      case '--ev-stagger': cfg.evStagger = true; break;
      case '--trade-direction': cfg.tradeDirection = tradeDirectionArg(nxt); i++; break;
      case '--martingale': cfg.martingaleEnabled = true; break;
      case '--martingale-multiplier': cfg.martingaleMultiplier = numArg(nxt, 'martingale-multiplier'); i++; break;
      case '--martingale-steps': cfg.martingaleSteps = numArg(nxt, 'martingale-steps'); i++; break;
      case '--ledger': cfg.ledgerPath = str(nxt, 'ledger'); i++; break;
      case '--max-losses': cfg.maxConsecutiveLosses = numArg(nxt, 'max-losses'); i++; break;
      case '--daily-loss-cap': cfg.dailyLossCap = numArg(nxt, 'daily-loss-cap'); i++; break;
      case '--backtest': cfg.backtest = true; break;
      case '--backtest-edge': cfg.backtestEdge = numArg(nxt, 'backtest-edge'); i++; break;
      case '--csv': cfg.csv = str(nxt, 'csv'); i++; break;
      case '--dry-run': cfg.dryRun = true; break;
      case '--skip-contract-check': cfg.skipContractCheck = true; break;
      case '--no-ui': cfg.noUi = true; break;
      case '--telegram-token': cfg.telegramToken = str(nxt, 'telegram-token'); i++; break;
      case '--telegram-chat-id': cfg.telegramChatId = str(nxt, 'telegram-chat-id'); i++; break;
      case '--state-path': cfg.statePath = str(nxt, 'state-path'); i++; break;
      default:
        // Allow --no-* flags to pass through for post-loop handling
        if (a.startsWith('--no-')) break;
        if (a.startsWith('-')) err(`unknown flag: ${a}`);
        err(`unexpected positional argument: ${a}`);
    }
  }

  // K grid must be sorted ascending — the selector assumes it.
  cfg.kCandidates = [...new Set(cfg.kCandidates)].sort((a, b) => a - b);

  // Negating flags for the new ON-by-default booleans. These let users opt back
  // out without remembering the env-var dance.
  if (argv.includes('--no-ev-mode')) cfg.evMode = false;
  if (argv.includes('--no-ev-stagger')) cfg.evStagger = false;
  if (argv.includes('--no-martingale')) cfg.martingaleEnabled = false;

  // Block length must be a positive integer and map to a Deriv candle granularity.
  if (!Number.isInteger(cfg.blockMinutes) || cfg.blockMinutes <= 0) {
    err(`--block-minutes must be a positive integer (got '${cfg.blockMinutes}')`);
  }
  const blkSec = cfg.blockMinutes * 60;
  if (!ALLOWED_CANDLE_GRANULARITIES.has(blkSec)) {
    err(
      `--block-minutes ${cfg.blockMinutes} (${blkSec}s) is not an allowed candle ` +
        `granularity — use one of: 1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440 min`,
    );
  }

  // Regime blend window must be a positive integer number of block-windows;
  // the blend itself must live in [0, 1].
  if (cfg.regimeBars !== undefined && (!Number.isInteger(cfg.regimeBars) || cfg.regimeBars <= 0)) {
    err(`--regime-bars must be a positive integer (got '${cfg.regimeBars}')`);
  }
  if (cfg.regimeBlend !== undefined && (cfg.regimeBlend < 0 || cfg.regimeBlend > 1)) {
    err(`--regime-blend must be between 0 and 1 (got '${cfg.regimeBlend}')`);
  }

  return { cfg, help, version };
}

export function helpText(): string {
  return usage();
}
