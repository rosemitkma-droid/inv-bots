/**
 * Phase 1 — EV-first band selection.
 *
 * The fixed-K predictor (blockOpen ± K·mean excursion) can't tell whether a
 * block is worth trading: it knows nothing about what Deriv will PAY for a
 * given barrier. This module estimates the TRUE win probability of each
 * candidate band from same-TOD history, quotes the candidate barriers through
 * Deriv to learn what the market pays (impliedP = ask/payout), and picks the
 * K that maximises combined block EV = Σ (trueP − impliedP)·payout — skipping
 * the block entirely when even the best K is below `minEv`.
 *
 * True-probability model (grounded in the random-walk research):
 *   synthetics are driftless random walks, so a block is a Brownian motion
 *   with per-tick volatility σ. The distribution of the MAX excursion over
 *   the block has a closed form (reflection principle):
 *
 *     P(max excursion < d) = 2Φ(d / σ·√T) − 1        (no-touch win rate)
 *     P(exit spot within d) = Φ(d / σ·√T)            (HIGHER/LOWER win rate)
 *
 *   σ is calibrated per side from the observed same-TOD mean excursion:
 *   E[max] = σ·√(2T/π)  ⇒  σ = meanExcursion / √(2T/π).
 *
 *   The choice of T (seconds vs ticks) cancels out — the SAME T is used to
 *   calibrate σ and to evaluate win rates — so the model is independent of
 *   the symbol's actual tick cadence.
 *
 * EV is relative: (trueP − impliedP) is only non-zero where the house's own
 * volatility/pricing model disagrees with ours. The selector merely makes the
 * decision mechanical; whether the edge is real is what dry-run and live P/L
 * measure. EV mode is OFF by default — the legacy fixed-K band remains.
 */

import type { Candle } from '../services/derivWS/types';
import { dayStart } from './rangePredictor';
import { blendMeans, recentExcursions, type RegimeParams } from './regime';
import type { TradeMode } from '../trading/config';

export type BandLeg = 'HIGHER' | 'LOWER';

const SECONDS_PER_DAY = 86_400;

/** Standard-normal CDF via A&S 7.1.26 (|err| ≈ 1.5e-7). */
export function normCdf(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const inner =
    (((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
    0.254829592;
  const erf = 1 - t * inner * Math.exp(-x * x);
  return 0.5 * (1 + Math.sign(z) * erf);
}

/**
 * Win probability of a stay-in-range leg whose barrier sits `z` block
 * volatilities away from the anchor. Side-symmetric: the lower leg's
 * P(min > −d) equals the upper leg's P(max < d) for a driftless walk.
 */
export function winRateFromZ(z: number, mode: TradeMode): number {
  return mode === 'no-touch' ? 2 * normCdf(z) - 1 : normCdf(z);
}

export interface WinRateModel {
  meanUp: number;
  meanDn: number;
  /** Per-tick vol, calibrated from the same-TOD mean up-excursion. */
  sigmaUp: number;
  /** Per-tick vol, calibrated from the same-TOD mean down-excursion. */
  sigmaDn: number;
  /** Block duration in ticks (≈ seconds on 1HZ synthetics). */
  ticks: number;
  daysUsed: number;
}

export function winRateModelFromMeans(
  meanUp: number,
  meanDn: number,
  blockSec: number,
  daysUsed: number,
): WinRateModel {
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

/** Per-side block volatility σ·√T, the natural distance unit for win rates. */
export function legSigmaBlock(model: WinRateModel, side: BandLeg): number {
  const sigma = side === 'HIGHER' ? model.sigmaUp : model.sigmaDn;
  return sigma * Math.sqrt(model.ticks);
}

export function winRate(
  model: WinRateModel,
  mode: TradeMode,
  side: BandLeg,
  distance: number,
): number {
  return winRateFromZ(distance / legSigmaBlock(model, side), mode);
}

/**
 * Same-TOD excursion statistics over the last `lookbackDays` blocks — the same
 * loop predictRange uses, kept here so EV selection is self-contained. Returns
 * null when no same-TOD history exists.
 *
 * Phase 4 regime: when `regime` is set and blend > 0, the same-TOD means are
 * blended toward recent realized vol BEFORE the σ calibration — equivalent to
 * blending σ directly, since σ = mean/√(2T/π) is a fixed linear rescaling.
 * This makes the model's trueP honest against current vol while the candidate
 * distances (k·mean) scale together with σ.
 */
export function estimateWinRates(
  candles: Candle[],
  blockStart: number,
  blockEnd: number,
  lookbackDays: number,
  regime?: RegimeParams,
): WinRateModel | null {
  const blockSec = blockEnd - blockStart;
  if (blockSec <= 0 || lookbackDays <= 0) return null;

  const todStart = blockStart - dayStart(blockStart);
  const todEnd = blockEnd - dayStart(blockStart);
  const anchorDay = dayStart(blockStart);

  let sumUp = 0;
  let sumDn = 0;
  let daysUsed = 0;
  for (let d = 1; d <= lookbackDays; d++) {
    const histDay = anchorDay - d * SECONDS_PER_DAY;
    const hStart = histDay + todStart;
    const hEnd = histDay + todEnd;

    let hOpen = Number.NaN;
    let hHigh = -Infinity;
    let hLow = Infinity;
    let found = false;
    for (const c of candles) {
      if (c.epoch >= hEnd) break;
      if (c.epoch < hStart) continue;
      if (!found) {
        hOpen = c.open;
        hHigh = c.high;
        hLow = c.low;
        found = true;
      } else {
        if (c.high > hHigh) hHigh = c.high;
        if (c.low < hLow) hLow = c.low;
      }
    }
    if (found) {
      sumUp += hHigh - hOpen;
      sumDn += hOpen - hLow;
      daysUsed++;
    }
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

export interface LegQuote {
  /** Total payout returned on a win (stake + profit). */
  payout: number;
  /** Market-implied win probability at quote time (ask/payout). */
  impliedP: number;
}

export interface QuoteRequest {
  k: number;
  side: BandLeg;
  /** Absolute barrier price. */
  barrier: number;
  /** Seconds left in the block (drives the proposal duration). */
  durationSec: number;
  /** |barrier − spot| — the excursion this barrier guards. */
  distance: number;
  /** Our model's trueP for this leg at this distance. */
  trueP: number;
  /** σ·√T for this leg — lets a simulated house rescale its own vol. */
  sigmaBlock: number;
}

export type BandQuoteFn = (req: QuoteRequest) => Promise<LegQuote | null>;

export interface BandCandidate {
  k: number;
  distanceUp: number;
  distanceDn: number;
  predHigh: number;
  predLow: number;
  truePUp: number;
  truePDn: number;
  payoutUp?: number;
  payoutDn?: number;
  impliedPUp?: number;
  impliedPDn?: number;
  evUp?: number;
  evDn?: number;
  /** Combined EV; undefined if either leg failed to quote. */
  evBlock?: number;
}

export interface BandSelection {
  model: WinRateModel;
  /** == spot — the EV band is anchored at the live entry price. */
  blockOpen: number;
  candidates: BandCandidate[];
  best: BandCandidate | null;
  /** K to trade, or null when the best EV is below minEv (or nothing quoted). */
  selectedK: number | null;
}

/**
 * Quote every candidate K (both legs), compute combined EV, and return the
 * best band. Returns null when there is no same-TOD history to estimate from.
 */
export async function selectBand(args: {
  candles: Candle[];
  blockStart: number;
  blockEnd: number;
  spot: number;
  mode: TradeMode;
  kCandidates: number[];
  minEv: number;
  lookbackDays: number;
  quote: BandQuoteFn;
  /** Override the proposal duration. Defaults to the wall-clock time left in the
   *  block — but a backtest/replay has no "now", so callers pass the full block
   *  length there. */
  durationSec?: number;
  /** Phase 4 regime blend, forwarded to estimateWinRates (blend 0 = off). */
  regime?: RegimeParams;
}): Promise<BandSelection | null> {
  const { candles, blockStart, blockEnd, spot, mode, kCandidates, minEv, lookbackDays, quote } = args;
  const model = estimateWinRates(candles, blockStart, blockEnd, lookbackDays, args.regime);
  if (!model) return null;

  const durationSec = args.durationSec ?? Math.max(15, Math.floor(blockEnd - Date.now() / 1000));
  const candidates: BandCandidate[] = [];

  for (const k of kCandidates) {
    const distanceUp = k * model.meanUp;
    const distanceDn = k * model.meanDn;
    const predHigh = spot + distanceUp;
    const predLow = spot - distanceDn;
    const truePUp = winRate(model, mode, 'HIGHER', distanceUp);
    const truePDn = winRate(model, mode, 'LOWER', distanceDn);

    const [qUp, qDn] = await Promise.all([
      quote({
        k, side: 'HIGHER', barrier: predHigh, durationSec,
        distance: distanceUp, trueP: truePUp, sigmaBlock: legSigmaBlock(model, 'HIGHER'),
      }),
      quote({
        k, side: 'LOWER', barrier: predLow, durationSec,
        distance: distanceDn, trueP: truePDn, sigmaBlock: legSigmaBlock(model, 'LOWER'),
      }),
    ]);

    const c: BandCandidate = { k, distanceUp, distanceDn, predHigh, predLow, truePUp, truePDn };
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

  let best: BandCandidate | null = null;
  for (const c of candidates) {
    if (c.evBlock === undefined) continue;
    if (!best || c.evBlock > best.evBlock!) best = c;
  }
  const selectedK = best && best.evBlock! >= minEv ? best.k : null;
  return { model, blockOpen: spot, candidates, best, selectedK };
}
