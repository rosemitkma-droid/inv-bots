import type { RangeMode } from '../engine/rangePredictor';

/**
 * Which Deriv contract primitive each block's pair is opened as:
 *   - 'higher-lower': breakout bet. Upper leg = HIGHER @ predH, lower leg =
 *     LOWER @ predL. A leg wins if exit spot is strictly past its barrier.
 *   - 'no-touch':     stay-in-range bet. Both legs are NOTOUCH — upper @
 *     predH, lower @ predL. A leg wins only if spot NEVER touches its
 *     barrier during the block. Both win ⇒ price stayed in [predL, predH].
 */
export type TradeMode = 'higher-lower' | 'no-touch';

export interface HiLoConfig {
  // Auth / transport
  appId: string;
  token: string;
  accountId?: string;
  preferAccountType?: 'demo' | 'real';

  // Market
  symbol: string;
  currency: string;

  // Sizing
  stake: number; // per-leg stake

  // Block grid
  blockMinutes: number;

  // Trade primitive
  mode: TradeMode;

  // Take-profit / stop
  blockTp: number;       // close pair when summed live P/L >= this (per-block)
  blockSl?: number;      // close pair when summed live P/L <= -this (per-block)
  blockTrail?: number;   // close pair when P/L retraces this far below its peak
  sessionTp?: number;    // halt trading when session P/L >= this
  sessionSl?: number;    // halt trading when session P/L <= -this
  /** Path to the persistent CSV ledger. When set, each realised block appends a
   *  row and the session seeds its daily P&L from the ledger at boot. */
  ledgerPath?: string;
  /** Halt after this many consecutive losing blocks. 0 disables. */
  maxConsecutiveLosses?: number;
  /** Halt when today's realised P&L <= -this (UTC day). 0 disables. */
  dailyLossCap?: number;
  /** Run the replay backtester and exit (no TUI, no trading). */
  backtest?: boolean;
  /** Simulated house vol premium for the backtest's leg quotes. 0 = fair house. */
  backtestEdge?: number;
  /** Optional path to an OHLC CSV (epoch,open,high,low,close) for the backtest.
   *  When omitted, `--backtest` pulls live candle history via Deriv (--token). */
  csv?: string;

  // Prediction model
  rangeMode: RangeMode;
  lookbackDays: number;
  atrBars: number;
  rangeK: number;
  /**
   * Volatility regime detection (Phase 4). `regimeBlend > 0` blends recent
   * realized vol (over the last `regimeBars` completed block-windows) into the
   * same-TOD mean excursion so bands and the win-rate model track current vol.
   * HARD config — changing it auto-stops the bot (part of the prediction model).
   * Default 0 = off (bit-identical to Phase 3 behaviour).
   */
  regimeBars?: number;
  regimeBlend?: number;

  /**
   * EV-first band selection (Phase 1). When true, onBlockStart skips the
   * fixed-K predictor and instead quotes several candidate K values through
   * Deriv, estimates each band's true win probability from same-TOD history,
   * picks the K with the highest combined EV, and skips the block if even the
   * best EV is below `minEv`. When false (default), the band is the classic
   * blockOpen ± rangeK·mean excursion and EV is only *measured*, not acted on.
   */
  evMode: boolean;
  /** K grid the EV selector quotes over. Sorted ascending at parse time. */
  kCandidates: number[];
  /** Skip the block when the best candidate's combined EV is below this (currency units). */
  minEv: number;
  /** Simulated house edge for dry-run pricing — impliedP = trueP · (1+edge). */
  dryRunEdge?: number;
  /**
   * Edge-scaled per-leg stake (Phase 2): stake = base × clamp(1 + 2·edge),
   * edge = trueP − impliedP. When true, legs whose quoted price disagrees most
   * with our win-rate model are sized up, agreeing legs sized down. Default
   * off — each leg keeps the flat `stake`.
   */
  evStagger: boolean;

  // Telegram notifications
  telegramToken?: string;
  telegramChatId?: string;

  // State persistence — JSON file that survives reconnects / restarts.
  /** Path to the persistent session-state JSON. When set, session stats
   *  (trades, wins, losses, totalProfit, dayProfit) are saved on every
   *  trade result and restored on boot. */
  statePath?: string;

  // Modes
  dryRun: boolean;
  /** Skip the contracts_for check. For debugging only — Deriv will reject the proposal. */
  skipContractCheck: boolean;
  /** If true, render plain console output instead of the Ink TUI. */
  noUi: boolean;
}

export function blockSeconds(cfg: HiLoConfig): number {
  return cfg.blockMinutes * 60;
}
