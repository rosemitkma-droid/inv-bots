export const DERIV_REST_BASE = 'https://api.derivws.com/trading/v1/options';
export const DEFAULT_APP_ID = '331jnczBJfg53USa1NUZm';

export const PING_INTERVAL_MS = 30_000;

// Session rollover: Deriv caps an authenticated WS session around ~1h. Mint a
// fresh OTP and swap sockets before the server drops us so trading never pauses.
export const SESSION_ROLLOVER_MS = 50 * 60 * 1_000;

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * Granularities Deriv accepts for `ticks_history` with `style=candles` (seconds).
 * A block's length (`blockMinutes * 60`) must match one of these or candle
 * history/subscriptions fail with a cryptic server error.
 */
export const ALLOWED_CANDLE_GRANULARITIES: ReadonlySet<number> = new Set([
  60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
]);

/** Throw unless `blockMinutes` maps to an allowed candle granularity. */
export function assertBlockGranularity(blockMinutes: number): void {
  const sec = blockMinutes * 60;
  if (!ALLOWED_CANDLE_GRANULARITIES.has(sec)) {
    throw new Error(
      `block of ${blockMinutes} min = ${sec}s is not a Deriv candle granularity. ` +
        `Allowed blocks (min): 1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440.`,
    );
  }
}

// Defaults tuned for 3-minute time-block trading on 1HZ synthetic indices.
export const DEFAULT_SYMBOL = '1HZ100V';
export const DEFAULT_STAKE = 1.0;
export const DEFAULT_BLOCK_MINUTES = 3;
export const DEFAULT_BLOCK_TP = 1.5;
/** Default per-block stop-loss (combined pair P/L). 0 = disabled. */
export const DEFAULT_BLOCK_SL = 0;
/**
 * Default trailing exit: sell when the pair retraces this far below its intrabar
 * peak. Arms once the peak reaches half the block-TP (DEFAULT_TRAIL_ARM_FRACTION).
 */
export const DEFAULT_BLOCK_TRAIL = 0.5;
/** Trail arms once the peak reaches this fraction of blockTp. */
export const DEFAULT_TRAIL_ARM_FRACTION = 0.5;
export const DEFAULT_LOOKBACK_DAYS = 20;
export const DEFAULT_ATR_BARS = 14;
export const DEFAULT_RANGE_K = 1.0;
export const DEFAULT_RANGE_MODE: 'hybrid' | 'historical' | 'atr' = 'hybrid';
/**
 * no-touch pays ~1.8× more per win and the EV selector's steeper payout curve
 * surfaces house mispricings more clearly. Both modes break even at fair house;
 * no-touch's payout premium is the better starting point for live trading.
 */
export const DEFAULT_TRADE_MODE: 'higher-lower' | 'no-touch' = 'no-touch';

// ─── EV-first band selection (Phase 1) ────────────────────────────────────────

/**
 * EV-first band selection is ON by default — it's the edge-harvesting mechanism
 * the entire upgrade thesis depends on. Without it the bot just trades every
 * block at fair-house odds (break-even).
 */
export const DEFAULT_EV_MODE = true;
/**
 * K grid the selector quotes over. Roughly the 50th–85th percentile excursion.
 * At K=1 (mean excursion) coverage is ~50%; the far end of the grid is where a
 * stay-in-range pair starts clearing the ~55% break-even.
 */
export const DEFAULT_K_CANDIDATES = [1.0, 1.5, 2.0, 2.5, 3.0];
/**
 * Minimum combined block EV (currency units) to open a pair. With stake=1 and
 * payout≈1.8× this is ~±0.1–0.2 per leg at the grid edges. 0.15 is the
 * recommended starting point — high enough to skip genuinely zero-EV blocks,
 * low enough to trade blocks where the house misprices. Lower to 0.10 for more
 * activity, raise to 0.20 if too many losing trades.
 */
export const DEFAULT_MIN_EV = 0.15;
/** Dry-run simulated house edge (see engine/dryRunPricing.ts). */
export const DEFAULT_DRY_RUN_EDGE = 0.03;
/**
 * Edge-scaled per-leg stake is ON by default — legs with higher model-vs-house
 * edge get up to 2× stake, legs with lower edge get down to 0.5×. Free
 * convexity: it doesn't change which blocks trade, just sizes the better leg
 * heavier.
 */
export const DEFAULT_EV_STAGGER = true;

// ─── Phase 3: survival & measurement ──────────────────────────────────────────

/** Ledger is off by default — set --ledger / HILO_LEDGER to persist block rows. */
export const DEFAULT_LEDGER_PATH = '';
/** Backtest house vol premium: 0 = fair house (a calibrated model shows EV≈0). */
export const DEFAULT_BACKTEST_EDGE = 0;
/**
 * Halt after N consecutive losing blocks. 5 is tight enough to catch a model
 * that's wrong about current vol, loose enough to survive normal variance.
 */
export const DEFAULT_MAX_CONSECUTIVE_LOSSES = 25;
/**
 * Halt when today's realised P&L <= -this (USD, UTC day). 20 at $2/leg stake
 * is ~5–10 losing blocks — a full session of bad luck or a stale model.
 */
export const DEFAULT_DAILY_LOSS_CAP = 20;

// ─── Phase 4: volatility regime detection ─────────────────────────────────────

/**
 * How many completed block-windows of recent realized vol to measure. 24 blocks
 * at 3-min granularity ≈ the last ~72 minutes of actual market behaviour.
 */
export const DEFAULT_REGIME_BARS = 24;
/**
 * How much recent vol displaces the same-TOD mean. 0 (the default) = regime
 * detection off, output bit-identical to Phase 3. 1 = the model uses recent
 * vol alone. Values in between interpolate. For live trading start at 0.2
 * (20% blend) to keep the model from being too stale during vol spikes without
 * chasing noise.
 */
export const DEFAULT_REGIME_BLEND = 0;
export const DEFAULT_SESSION_TP = 15;
export const DEFAULT_SESSION_SL = 10;
