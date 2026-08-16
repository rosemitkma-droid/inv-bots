import { describe, expect, test } from 'bun:test';
import { ALLOWED_CANDLE_GRANULARITIES, assertBlockGranularity } from './api';

describe('block granularity guard', () => {
  test('allowed block sizes pass', () => {
    for (const min of [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440]) {
      expect(() => assertBlockGranularity(min)).not.toThrow();
    }
  });

  test('deriv candles accept the allowed granularities', () => {
    // The set is the exact list Deriv supports for ticks_history/candles.
    expect(ALLOWED_CANDLE_GRANULARITIES.has(60)).toBe(true);
    expect(ALLOWED_CANDLE_GRANULARITIES.has(300)).toBe(true);
    expect(ALLOWED_CANDLE_GRANULARITIES.has(3600)).toBe(true);
    expect(ALLOWED_CANDLE_GRANULARITIES.has(86400)).toBe(true);
  });

  test('disallowed block sizes throw with a helpful message', () => {
    for (const min of [4, 7, 11, 90, 45, 0, -3]) {
      expect(() => assertBlockGranularity(min)).toThrow(/not a Deriv candle granularity/i);
    }
  });
});
