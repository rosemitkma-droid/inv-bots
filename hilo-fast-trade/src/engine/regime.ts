/**
 * Phase 4 — volatility regime detection.
 *
 * The win-rate model calibrates σ from a 20-day same-TOD mean excursion.
 * Volatility is not stationary: during a vol spike the house (pricing from
 * live recent vol) quotes cheap stay-in-range payouts while our stale low-σ
 * model computes large positive EV → over-traded phantom edge. This module
 * measures recent realized vol as a mean block excursion over the last few
 * COMPLETED block windows and blends it into the same-TOD means, so bands
 * widen and trueP tracks current vol.
 *
 * Blend 0 (the default) is the identity — every caller short-circuits to
 * today's output. Because winRateModelFromMeans derives σ = mean/√(2T/π) — a
 * fixed linear rescaling for a constant block T — blending at the MEAN level is
 * exactly equivalent to blending σ directly.
 */

import type { Candle } from '../services/derivWS/types';

export interface RegimeParams {
  /** How many completed block-windows of recent realized vol to measure. */
  bars: number;
  /** How much recent vol displaces the same-TOD mean: 0 = off, 1 = recent only. */
  blend: number;
}

export interface RecentExcursions {
  /** Mean upside excursion (max high − first open) per window. */
  up: number;
  /** Mean downside excursion (first open − min low) per window. */
  dn: number;
  /** Windows that actually had data (gaps don't pollute the mean). */
  count: number;
}

export interface BlendedMeans {
  meanUp: number;
  meanDn: number;
  /** Diagnostics: recent/same-TOD, clamped. Never used in the blend itself. */
  ratioUp: number;
  ratioDn: number;
}

export const REGIME_RATIO_MIN = 0.25;
export const REGIME_RATIO_MAX = 4;

/**
 * Mean up/dn block excursion over the last `bars` COMPLETED block-windows
 * [wStart, wStart + blockSec), wStart < blockStart. Each window aggregates
 * (max high − first.open) and (first.open − min low) over its candles — the
 * same definition as the same-TOD loop in estimateWinRates/predictRange — so
 * window-bucketing keeps the measure comparable for any candle granularity,
 * not just block-granularity candles.
 *
 * No future peek: every window ends before blockStart, so nothing after the
 * prediction moment is observed. count = windows with data (gaps don't pollute
 * the mean). Null when no prior window has a candle.
 */
export function recentExcursions(
  candles: Candle[],
  blockStart: number,
  blockEnd: number,
  bars: number,
): RecentExcursions | null {
  if (!(blockEnd > blockStart)) return null;
  const blockSec = blockEnd - blockStart;
  const windows = Math.floor(bars);
  if (!(windows >= 1)) return null;

  let sumUp = 0;
  let sumDn = 0;
  let count = 0;
  for (let w = 1; w <= windows; w++) {
    const wStart = blockStart - w * blockSec;
    const wEnd = wStart + blockSec;
    let o = Number.NaN;
    let hi = -Infinity;
    let lo = Infinity;
    let found = false;
    for (const c of candles) {
      if (c.epoch >= wEnd) break;
      if (c.epoch < wStart) continue;
      if (!found) {
        o = c.open;
        hi = c.high;
        lo = c.low;
        found = true;
      } else {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
      }
    }
    if (found) {
      sumUp += hi - o;
      sumDn += o - lo;
      count++;
    }
  }
  if (count === 0) return null;
  return { up: sumUp / count, dn: sumDn / count, count };
}

/**
 * blended = sameTod + clamp01(blend)·(recent − sameTod), per side. A side with
 * a non-positive same-TOD or recent mean falls back to the same-TOD mean with
 * ratio 1 — the interpolation is safe for near-zero inputs (both operands are
 * positive and b ∈ [0,1] pins the result between them); only an exact zero is
 * guarded. Ratios are diagnostics-only, clamped to [REGIME_RATIO_MIN, MAX].
 */
export function blendMeans(
  sameTodUp: number,
  sameTodDn: number,
  recent: RecentExcursions,
  blend: number,
): BlendedMeans {
  const b = Math.min(1, Math.max(0, blend));
  const side = (sameTod: number, recentVal: number): { mean: number; ratio: number } => {
    if (!(sameTod > 0) || !(recentVal > 0)) {
      return { mean: sameTod, ratio: 1 };
    }
    const ratio = Math.min(REGIME_RATIO_MAX, Math.max(REGIME_RATIO_MIN, recentVal / sameTod));
    return { mean: sameTod + b * (recentVal - sameTod), ratio };
  };
  const up = side(sameTodUp, recent.up);
  const dn = side(sameTodDn, recent.dn);
  return { meanUp: up.mean, meanDn: dn.mean, ratioUp: up.ratio, ratioDn: dn.ratio };
}

/**
 * RegimeParams from config, or undefined when blend ≤ 0 (the default-off gate).
 * Callers short-circuit to today's output when this returns undefined.
 */
export function regimeFromConfig(cfg: {
  regimeBars?: number;
  regimeBlend?: number;
}): RegimeParams | undefined {
  const blend = cfg.regimeBlend ?? 0;
  if (!(blend > 0)) return undefined;
  const bars = Math.floor(cfg.regimeBars ?? 0);
  return bars > 0 ? { bars, blend } : undefined;
}
