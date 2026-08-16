/**
 * Phase 2 — early-exit logic (pure).
 *
 * The classic block TP is a hard gate: sell when combined P/L >= blockTp. This
 * module adds the two exits that turn "hit a fixed number" into "lock in a
 * move", plus edge-scaled sizing:
 *
 *   - TP   — sell when combined P/L >= blockTp (unchanged from Phase 0).
 *   - SL   — sell sellable legs when combined P/L <= -blockSl, so a bad block
 *            can't run away to expiry at full stake.
 *   - trail — sell when combined P/L retraces a fixed USD amount (`blockTrail`)
 *            from its intrabar peak, once the peak has reached `trailArmAt`
 *            (a fraction of the TP). A pair that went +2.10 then back to +1.40
 *            locks in +1.40 instead of riding to expiry.
 *   - stagger — per-leg stake = baseStake × clamp(1 + α·edge), where
 *            edge = trueP − impliedP. We bet more where the quoted price
 *            disagrees most with our own win-rate model, less where it agrees.
 *
 * Also included: a mark-to-market helper used only by the dry-run tick feed.
 * Live mode gets P/L from Deriv's proposal_open_contract stream; dry-run has no
 * server, so each synthetic tick re-prices each leg as
 *   profit = (payout − stake)·P(win now) − stake·(1 − P(win now)),
 * where P(win now) is the same reflection-principle win rate evaluated at the
 * current distance and the REMAINING block time. This makes the new exits
 * observable in dry-run instead of every pair riding to expiry.
 *
 * All exit decisions are a pure function of the current state + the accumulated
 * intrabar peak, so they're unit-testable without any Deriv or store plumbing.
 */

import { winRateFromZ } from './bandSelector';
import type { TradeMode } from '../trading/config';

export type ExitReason = 'tp' | 'trail' | 'sl';

export interface ExitState {
  /** Highest combined P/L seen since the pair opened (or re-armed). */
  peakPL: number;
  /** True once peakPL has reached the trail arming threshold. */
  trailArmed: boolean;
}

export function newExitState(): ExitState {
  return { peakPL: 0, trailArmed: false };
}

export interface ExitEval {
  exit: boolean;
  reason?: ExitReason;
}

/**
 * Decide whether to exit the pair now. Updates `state.peakPL` / `state.trailArmed`
 * in place (it's an accumulator). Precedence: TP, then SL, then trail.
 */
export function evaluatePairExit(args: {
  state: ExitState;
  profit: number;
  /** Sell when combined P/L >= this. 0 disables. */
  blockTp: number;
  /** Sell when combined P/L <= -this. 0 disables. */
  blockSl: number;
  /** Sell when P/L retraces this far below its peak. 0 disables. */
  blockTrail: number;
  /** Peak must reach this before the trail can fire. <= 0 disables trailing. */
  trailArmAt: number;
}): ExitEval {
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
 * Edge = trueP − impliedP is a probability difference (roughly ±0.2 on a
 * stay-in-range leg), so α=2 keeps the multiplier in a sensible band by default.
 */
export function staggerStake(args: {
  baseStake: number;
  edge: number;
  alpha?: number;
  minRatio?: number;
  maxRatio?: number;
}): number {
  const { baseStake, edge } = args;
  const alpha = args.alpha ?? 2;
  const minRatio = args.minRatio ?? 0.5;
  const maxRatio = args.maxRatio ?? 2;
  const ratio = Math.min(maxRatio, Math.max(minRatio, 1 + alpha * edge));
  return Math.max(0.01, Math.round(baseStake * ratio * 100) / 100);
}

/**
 * P(win now) for an open leg, marked from the CURRENT distance and the
 * remaining block time — the reflection-principle win rate with z measured
 * against the per-tick vol scaled by √(time left). At entry this equals the
 * leg's trueP; near expiry it collapses to 1 (barrier far away) or 0 (barrier
 * crossed for NOTOUCH / unreachable for HIGHER/LOWER).
 */
export function currentWinProb(args: {
  distance: number;
  sigmaPerTick: number;
  secondsRemaining: number;
  mode: TradeMode;
}): number {
  const { distance, sigmaPerTick, mode } = args;
  const rem = Math.max(1, args.secondsRemaining);
  if (!(sigmaPerTick > 0)) return 0.5;
  return winRateFromZ(distance / (sigmaPerTick * Math.sqrt(rem)), mode);
}

/**
 * Mark-to-market P/L of a single leg given its current win probability:
 * the expected payout less the stake we're still risking.
 */
export function markToMarketProfit(args: {
  payout: number;
  stake: number;
  currentWinP: number;
}): number {
  const { payout, stake, currentWinP } = args;
  return (payout - stake) * currentWinP - stake * (1 - currentWinP);
}
