import { describe, expect, test } from 'bun:test';
import { predictRange, dayStart, type RangePrediction } from './rangePredictor';
import type { Candle } from '../services/derivWS/types';

const SECONDS_PER_DAY = 86_400;
const BLOCK_SEC = 180; // 3-minute block

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** One candle per block, aligned to the UTC grid, for `days` days of blocks. */
function makeCandles(opts: {
  days: number;
  openAt: (d: number, b: number) => number;
  range: number;
  seed?: number;
}): Candle[] {
  const { days, openAt, range } = opts;
  const out: Candle[] = [];
  for (let d = 0; d < days; d++) {
    for (let b = 0; b < SECONDS_PER_DAY / BLOCK_SEC; b++) {
      const epoch = d * SECONDS_PER_DAY + b * BLOCK_SEC;
      const open = openAt(d, b);
      out.push({
        epoch,
        open,
        high: open + range,
        low: open - range,
        close: open + range * (0.4 - 0.8 * ((d + b) % 2)),
      });
    }
  }
  return out;
}

const flatCandles = makeCandles({
  days: 5,
  openAt: () => 1000,
  range: 1.0,
});

// Block starting at day 5, 00:00 UTC (block 0 of day 5). All prior days have a
// candle exactly at their own 00:00 block.
const BLOCK_START = 5 * SECONDS_PER_DAY;
const BLOCK_END = BLOCK_START + BLOCK_SEC;

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('dayStart', () => {
  test('floors to UTC midnight', () => {
    expect(dayStart(86_400 * 3 + 12345)).toBe(86_400 * 3);
    expect(dayStart(0)).toBe(0);
  });
});

describe('predictRange — historical model', () => {
  test('uses the block-open candle, not live spot, when the bar exists', () => {
    // Day-5 block 0 has no candle yet (the prediction runs at block start), so
    // blockOpen falls back to spot. Give it a spot.
    const pred = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1002, {
      mode: 'historical',
      lookbackDays: 3,
      atrBars: 14,
      k: 1,
      granularitySec: BLOCK_SEC,
    });
    expect(pred).not.toBeNull();
    expect(pred!.blockOpen).toBe(1002);
    expect(pred!.source).toBe('historical');
  });

  test('sizes band symmetrically around open when history is symmetric', () => {
    const pred = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, {
      mode: 'historical',
      lookbackDays: 3,
      atrBars: 14,
      k: 1,
      granularitySec: BLOCK_SEC,
    });
    expect(pred).not.toBeNull();
    const p = pred as RangePrediction;
    // For flat candles, mean up = mean down = range = 1.0, so K=1 gives
    // predH = open + 1.0, predL = open - 1.0.
    expect(p.predictedHigh - p.blockOpen).toBeCloseTo(1.0, 3);
    expect(p.blockOpen - p.predictedLow).toBeCloseTo(1.0, 3);
    expect(p.meanUp).toBeCloseTo(1.0, 3);
    expect(p.meanDown).toBeCloseTo(1.0, 3);
  });

  test('K scales the excursion linearly', () => {
    const k1 = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, {
      mode: 'historical', lookbackDays: 3, atrBars: 14, k: 1, granularitySec: BLOCK_SEC,
    });
    const k2 = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, {
      mode: 'historical', lookbackDays: 3, atrBars: 14, k: 2, granularitySec: BLOCK_SEC,
    });
    expect(k1 && k2).toBeTruthy();
    expect(k2!.predictedHigh - 1000).toBeCloseTo(2 * (k1!.predictedHigh - 1000), 3);
  });

  test('is non-repainting: same candles + same block => identical prediction', () => {
    const cfg = { mode: 'historical' as const, lookbackDays: 3, atrBars: 14, k: 1.2, granularitySec: BLOCK_SEC };
    const a = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, cfg);
    const b = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, cfg);
    expect(a).toEqual(b);
  });

  test('returns null when lookback has no same-TOD candles', () => {
    const pred = predictRange([], BLOCK_START, BLOCK_END, 1000, {
      mode: 'historical', lookbackDays: 3, atrBars: 14, k: 1, granularitySec: BLOCK_SEC,
    });
    expect(pred).toBeNull();
  });
});

describe('predictRange — ATR fallback', () => {
  test('atr mode sizes band from Wilder TR, ignores spot-relative', () => {
    // Build history with a stable 2-unit range so TR ≈ 2.
    const candles = makeCandles({ days: 2, openAt: () => 1000, range: 2 });
    const pred = predictRange(candles, BLOCK_START, BLOCK_END, 1000, {
      mode: 'atr', lookbackDays: 3, atrBars: 4, k: 1, granularitySec: BLOCK_SEC,
    });
    expect(pred).not.toBeNull();
    const p = pred as RangePrediction;
    // barsPerBlock = 180/180 = 1, so ext = 0.5 * atr * 1 * K.
    // TR per candle ≈ high-low = 4 for a range of 2. atr ≈ 4. ext ≈ 2.
    expect(p.predictedHigh - p.blockOpen).toBeGreaterThan(1.5);
    expect(p.predictedLow).toBeCloseTo(p.blockOpen - (p.predictedHigh - p.blockOpen), 6);
  });

  test('returns null with too little history', () => {
    const pred = predictRange([], BLOCK_START, BLOCK_END, 1000, {
      mode: 'atr', lookbackDays: 3, atrBars: 14, k: 1, granularitySec: BLOCK_SEC,
    });
    expect(pred).toBeNull();
  });
});

describe('predictRange — Phase 4 regime blend', () => {
  // Same-TOD mean excursion is exactly 1.0 (flatCandles range = 1.0).
  const HIST = { mode: 'historical' as const, lookbackDays: 3, atrBars: 14, k: 1, granularitySec: BLOCK_SEC };

  /**
   * flatCandles (range 1.0, days 0–4) with the LAST `n` completed block-windows
   * before BLOCK_START replaced by `range`-sized candles. Same-TOD (day-4 block
   * 0) stays 1.0; the trailing recent-vol window becomes `range`.
   */
  function withRecentRange(range: number, n = 4): Candle[] {
    const lastIdx = SECONDS_PER_DAY / BLOCK_SEC; // 480 blocks/day
    const cutoff = 4 * SECONDS_PER_DAY + (lastIdx - n) * BLOCK_SEC;
    const head = flatCandles.filter((c) => c.epoch < cutoff);
    const tail: Candle[] = [];
    for (let b = lastIdx - n; b < lastIdx; b++) {
      const epoch = 4 * SECONDS_PER_DAY + b * BLOCK_SEC;
      tail.push({ epoch, open: 1000, high: 1000 + range, low: 1000 - range, close: 1000 });
    }
    return [...head, ...tail];
  }

  test('blends recent realized vol into the historical mean and band', () => {
    // Same-TOD mean 1.0; the last 4 completed windows run at 3.0.
    const candles = withRecentRange(3);
    const base = predictRange(candles, BLOCK_START, BLOCK_END, 1000, HIST)!;
    const reg = predictRange(candles, BLOCK_START, BLOCK_END, 1000, {
      ...HIST, regime: { bars: 4, blend: 0.5 },
    })!;
    // Blend 0.5: meanUp = 1.0 + 0.5·(3.0 − 1.0) = 2.0, and the band follows.
    expect(reg.meanUp).toBeCloseTo(2.0, 9);
    expect(reg.predictedHigh - reg.blockOpen).toBeCloseTo(2.0, 9);
    expect(reg.meanDown).toBeCloseTo(2.0, 9);
    expect(reg.predictedLow).toBeCloseTo(reg.blockOpen - 2.0, 9);
    // Without regime the band stays at the plain same-TOD mean.
    expect(base.meanUp).toBeCloseTo(1.0, 9);
  });

  test('blend 1 = recent vol alone', () => {
    const candles = withRecentRange(3);
    const reg = predictRange(candles, BLOCK_START, BLOCK_END, 1000, {
      ...HIST, regime: { bars: 4, blend: 1 },
    })!;
    expect(reg.meanUp).toBeCloseTo(3.0, 9);
    expect(reg.predictedHigh - reg.blockOpen).toBeCloseTo(3.0, 9);
  });

  test('no-peek: a huge-range candle in the current block is ignored by the blend', () => {
    // Same-TOD mean 1.0, recent 1.0; a 100-range candle AT blockStart must not
    // leak into the recent-vol window (windows are strictly before blockStart).
    const candles = [...withRecentRange(1), { epoch: BLOCK_START, open: 1000, high: 1100, low: 900, close: 1000 }];
    const reg = predictRange(candles, BLOCK_START, BLOCK_END, 1000, {
      ...HIST, regime: { bars: 4, blend: 1 },
    })!;
    expect(reg.meanUp).toBeCloseTo(1.0, 9);
  });

  test('atr mode ignores regime (ATR is already a recent-vol measure)', () => {
    const candles = makeCandles({ days: 2, openAt: () => 1000, range: 2 });
    const cfg = { mode: 'atr' as const, lookbackDays: 3, atrBars: 4, k: 1, granularitySec: BLOCK_SEC };
    const base = predictRange(candles, BLOCK_START, BLOCK_END, 1000, cfg)!;
    const reg = predictRange(candles, BLOCK_START, BLOCK_END, 1000, {
      ...cfg, regime: { bars: 4, blend: 1 },
    })!;
    expect(reg).toEqual(base);
  });
});

describe('predictRange — hybrid', () => {
  test('prefers historical when days exist, falls back to ATR otherwise', () => {
    const hist = predictRange(flatCandles, BLOCK_START, BLOCK_END, 1000, {
      mode: 'hybrid', lookbackDays: 3, atrBars: 4, k: 1, granularitySec: BLOCK_SEC,
    });
    expect(hist!.source).toBe('historical');

    const fallback = predictRange([], BLOCK_START, BLOCK_END, 1000, {
      mode: 'hybrid', lookbackDays: 3, atrBars: 14, k: 1, granularitySec: BLOCK_SEC,
    });
    expect(fallback).toBeNull(); // no candles at all => no ATR either
  });
});
