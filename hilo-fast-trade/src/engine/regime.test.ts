import { describe, expect, test } from 'bun:test';
import {
  blendMeans,
  recentExcursions,
  regimeFromConfig,
  REGIME_RATIO_MAX,
  REGIME_RATIO_MIN,
} from './regime';
import type { Candle } from '../services/derivWS/types';

const SECONDS_PER_DAY = 86_400;
const BLOCK_SEC = 180;
const BLOCK_START = 5 * SECONDS_PER_DAY; // day 5, 00:00 UTC
const BLOCK_END = BLOCK_START + BLOCK_SEC;

function candle(epoch: number, up: number, dn: number): Candle {
  return { epoch, open: 1000, high: 1000 + up, low: 1000 - dn, close: 1000 };
}

/**
 * Ascending-by-epoch candles for the COMPLETED block-windows immediately
 * before BLOCK_START. ranges is OLDEST-FIRST; ranges[ranges.length-1] is the
 * window ending one block before BLOCK_START. So the last `bars` windows are
 * the trailing ranges.
 */
function recentSeries(ranges: Array<{ up: number; dn: number }>): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const epoch = BLOCK_START - (ranges.length - i) * BLOCK_SEC;
    out.push(candle(epoch, ranges[i].up, ranges[i].dn));
  }
  return out;
}

describe('recentExcursions', () => {
  test('averages the last `bars` completed block-windows', () => {
    const out = recentExcursions(
      recentSeries([{ up: 2, dn: 1 }, { up: 2, dn: 1 }, { up: 2, dn: 1 }, { up: 2, dn: 1 }]),
      BLOCK_START, BLOCK_END, 4,
    );
    expect(out).toEqual({ up: 2, dn: 1, count: 4 });
  });

  test('no future peek: candles at or after blockStart are ignored', () => {
    const candles = [...recentSeries([{ up: 2, dn: 1 }, { up: 2, dn: 1 }])];
    candles.push(candle(BLOCK_START, 100, 100)); // huge range in the CURRENT block
    candles.push(candle(BLOCK_START + BLOCK_SEC, 100, 100)); // and beyond
    const out = recentExcursions(candles, BLOCK_START, BLOCK_END, 2);
    expect(out).toEqual({ up: 2, dn: 1, count: 2 });
  });

  test('warmup: fewer windows than `bars` → count = windows with data', () => {
    const out = recentExcursions(
      recentSeries([{ up: 3, dn: 1 }, { up: 5, dn: 2 }, { up: 7, dn: 3 }]),
      BLOCK_START, BLOCK_END, 10,
    );
    expect(out).toEqual({ up: 5, dn: 2, count: 3 });
  });

  test('most-recent bias: only the last `bars` windows contribute', () => {
    // 8 windows: the 4 OLDEST at range 1, the 4 MOST RECENT at range 5.
    const series = [
      { up: 1, dn: 1 }, { up: 1, dn: 1 }, { up: 1, dn: 1 }, { up: 1, dn: 1 },
      { up: 5, dn: 5 }, { up: 5, dn: 5 }, { up: 5, dn: 5 }, { up: 5, dn: 5 },
    ];
    const out = recentExcursions(recentSeries(series), BLOCK_START, BLOCK_END, 4);
    expect(out).toEqual({ up: 5, dn: 5, count: 4 });
  });

  test('empty history → null', () => {
    expect(recentExcursions([], BLOCK_START, BLOCK_END, 4)).toBeNull();
  });

  test('null when no window has any data', () => {
    const out = recentExcursions(
      [candle(BLOCK_START + BLOCK_SEC, 1, 1), candle(BLOCK_START + 2 * BLOCK_SEC, 1, 1)],
      BLOCK_START, BLOCK_END, 4,
    );
    expect(out).toBeNull();
  });
});

describe('blendMeans', () => {
  const recent = { up: 4, dn: 3, count: 4 };
  const sameTod = { up: 2, dn: 1 };

  test('blend 0 = identity (default-off)', () => {
    const b = blendMeans(sameTod.up, sameTod.dn, recent, 0);
    expect(b.meanUp).toBeCloseTo(2, 9);
    expect(b.meanDn).toBeCloseTo(1, 9);
    expect(b.ratioUp).toBeCloseTo(2, 9);
    expect(b.ratioDn).toBeCloseTo(3, 9);
  });

  test('blend 1 = recent vol alone', () => {
    const b = blendMeans(sameTod.up, sameTod.dn, recent, 1);
    expect(b.meanUp).toBeCloseTo(4, 9);
    expect(b.meanDn).toBeCloseTo(3, 9);
  });

  test('blend 0.5 = midpoint', () => {
    const b = blendMeans(sameTod.up, sameTod.dn, recent, 0.5);
    expect(b.meanUp).toBeCloseTo(3, 9);
    expect(b.meanDn).toBeCloseTo(2, 9);
  });

  test('blend is clamped into [0, 1]', () => {
    expect(blendMeans(2, 1, recent, 1.7).meanUp).toBeCloseTo(4, 9);
    expect(blendMeans(2, 1, recent, -3).meanUp).toBeCloseTo(2, 9);
  });

  test('zero recent vol on a side falls back to the same-TOD mean (ratio 1)', () => {
    const b = blendMeans(2, 1, { up: 0, dn: 3, count: 4 }, 0.5);
    expect(b.meanUp).toBeCloseTo(2, 9); // unchanged
    expect(b.ratioUp).toBe(1);
    expect(b.meanDn).toBeCloseTo(2, 9);
  });

  test('zero same-TOD mean falls back to same-TOD (ratio 1)', () => {
    const b = blendMeans(0, 1, { up: 4, dn: 3, count: 4 }, 0.5);
    expect(b.meanUp).toBeCloseTo(0, 9);
    expect(b.ratioUp).toBe(1);
  });

  test('ratios are clamped to [REGIME_RATIO_MIN, REGIME_RATIO_MAX]', () => {
    const b = blendMeans(1, 1, { up: 10, dn: 0.1, count: 4 }, 0.5);
    expect(b.ratioUp).toBe(REGIME_RATIO_MAX);
    expect(b.ratioDn).toBe(REGIME_RATIO_MIN);
  });
});

describe('regimeFromConfig', () => {
  test('blend 0 (default) → undefined (off)', () => {
    expect(regimeFromConfig({})).toBeUndefined();
    expect(regimeFromConfig({ regimeBars: 24, regimeBlend: 0 })).toBeUndefined();
  });

  test('positive blend → regime params', () => {
    expect(regimeFromConfig({ regimeBars: 24, regimeBlend: 0.7 })).toEqual({ bars: 24, blend: 0.7 });
  });

  test('non-positive bars → undefined', () => {
    expect(regimeFromConfig({ regimeBars: 0, regimeBlend: 0.7 })).toBeUndefined();
  });
});
