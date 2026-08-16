import type { Candle } from '../services/derivWS/types';
import { blendMeans, recentExcursions, type RegimeParams } from './regime';

export type RangeMode = 'hybrid' | 'historical' | 'atr';

export interface RangePredictorConfig {
  mode: RangeMode;
  lookbackDays: number;
  atrBars: number;
  k: number;
  /**
   * Granularity (seconds) of the candle series passed in. Must divide blockSec.
   * Used to compute bars-per-block for the ATR fallback.
   */
  granularitySec: number;
  /**
   * Volatility regime blend (Phase 4). When set and blend > 0, the historical
   * same-TOD means are blended toward the recent realized mean excursion so the
   * band tracks current vol. Only applies to the historical branch — the ATR
   * fallback is itself a recent-vol measure. Default off (blend 0 = identity).
   */
  regime?: RegimeParams;
}

export interface RangePrediction {
  blockOpen: number;
  predictedHigh: number;
  predictedLow: number;
  source: 'historical' | 'atr';
  daysUsed: number;
  meanUp?: number;
  meanDown?: number;
  atr?: number;
}

const SECONDS_PER_DAY = 86_400;

/** Floor an epoch-seconds timestamp to the UTC midnight of its day. */
export function dayStart(epochSec: number): number {
  return Math.floor(epochSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/**
 * Non-repainting block high/low prediction. Anchored at the block's opening
 * price, sized by same-time-of-day historical excursions or an ATR fallback.
 *
 * Inputs
 *   - candles:   ascending-by-epoch OHLC series at a fixed granularity.
 *   - blockStart, blockEnd:  wall-clock window of the block we're predicting.
 *   - spot:      current tick price; used as fallback block-open if no candle
 *                has printed for the new block yet.
 *   - cfg:       mode + lookbackDays + atrBars + k + granularitySec.
 *
 * Output: { blockOpen, predictedHigh, predictedLow, source, … } or null when
 * neither model produced a prediction (e.g. no history + mode='historical').
 *
 * Historical model:
 *   For each of the last N days at the same time-of-day window [todStart, todEnd):
 *     sum_up += max(high) − first.open    (upside excursion from block open)
 *     sum_dn += first.open − min(low)     (downside excursion from block open)
 *   If days_used > 0:
 *     pred_high = blockOpen + K * mean_up
 *     pred_low  = blockOpen − K * mean_dn
 *
 * ATR fallback (Parkinson / Brownian-extreme scaling):
 *   atr = Wilder TR mean over last `atrBars` candles
 *   ext = 0.5 * atr * sqrt(bars_per_block) * K
 *   pred_high = blockOpen + ext
 *   pred_low  = blockOpen - ext
 *
 * When the candle feed is at block-size granularity (bars_per_block = 1), the
 * ATR term simplifies to 0.5 * atr * K.
 */
export function predictRange(
  candles: Candle[],
  blockStart: number,
  blockEnd: number,
  spot: number,
  cfg: RangePredictorConfig,
): RangePrediction | null {
  const blockSec = blockEnd - blockStart;
  if (blockSec <= 0) return null;

  // 1. Block open — first candle whose epoch falls in [blockStart, blockEnd).
  //    If no such candle exists (brand-new block, candle hasn't printed), use
  //    the live spot as a provisional block-open. The MQ5 indicator waits for
  //    a bar; we don't have that luxury on-the-fly and spot is the best proxy.
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

  // 2. Historical same-TOD block statistics.
  const todStart = blockStart - dayStart(blockStart);
  const todEnd = blockEnd - dayStart(blockStart);

  let sumUp = 0;
  let sumDn = 0;
  let daysUsed = 0;

  if (cfg.mode !== 'atr' && cfg.lookbackDays > 0) {
    const anchorDay = dayStart(blockStart);
    for (let d = 1; d <= cfg.lookbackDays; d++) {
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
  }

  if (daysUsed > 0) {
    const meanUp = sumUp / daysUsed;
    const meanDn = sumDn / daysUsed;
    // Phase 4 regime blend: pull the same-TOD means toward recent realized vol
    // so the band (and the returned model means) track current vol. Blend 0 /
    // warmup both fall back to the plain same-TOD means. The returned meanUp /
    // meanDown feed winRateModelFromMeans in the caller, so the model inherits
    // the blend for free.
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

  // 3. ATR fallback — Wilder true-range mean over last `atrBars` candles
  //    strictly before blockStart (avoid peeking at the current block's bar).
  const past: Candle[] = [];
  for (const c of candles) {
    if (c.epoch < blockStart) past.push(c);
  }
  if (past.length < cfg.atrBars + 1) return null;

  let sumTr = 0;
  const start = past.length - cfg.atrBars;
  for (let i = start; i < past.length; i++) {
    const cur = past[i]!;
    const prev = past[i - 1]!;
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
