import { describe, expect, test } from 'bun:test';
import {
  estimateWinRates,
  normCdf,
  selectBand,
  winRateFromZ,
  winRateModelFromMeans,
  type BandCandidate,
  type BandQuoteFn,
} from './bandSelector';
import { simulateQuote } from './dryRunPricing';
import type { Candle } from '../services/derivWS/types';

const SECONDS_PER_DAY = 86_400;
const BLOCK_SEC = 180;

/**
 * Deterministic same-TOD fixture: `days` days of 3-min blocks, each block a
 * single candle whose range equals `upRange` above open and `dnRange` below.
 * Excursion stats are exact: meanUp = upRange, meanDn = dnRange.
 */
function makeCandles(opts: { days: number; upRange: number; dnRange: number }): Candle[] {
  const { days, upRange, dnRange } = opts;
  const out: Candle[] = [];
  for (let d = 0; d < days; d++) {
    for (let b = 0; b < SECONDS_PER_DAY / BLOCK_SEC; b++) {
      const epoch = d * SECONDS_PER_DAY + b * BLOCK_SEC;
      out.push({
        epoch,
        open: 1000,
        high: 1000 + upRange,
        low: 1000 - dnRange,
        close: 1000,
      });
    }
  }
  return out;
}

/** Block at day 5, 00:00 UTC — every prior day has a candle at that exact TOD. */
const BLOCK_START = 5 * SECONDS_PER_DAY;
const BLOCK_END = BLOCK_START + BLOCK_SEC;
const SPOT = 1000;

// ─── Statistics primitives ───────────────────────────────────────────────────

describe('normCdf', () => {
  test('symmetric + known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 2);
  });
});

describe('winRateFromZ', () => {
  test('both modes agree at z=0 (fair coin)', () => {
    expect(winRateFromZ(0, 'higher-lower')).toBeCloseTo(0.5, 6);
    expect(winRateFromZ(0, 'no-touch')).toBeCloseTo(0, 6);
  });
  test('no-touch is strictly stricter than exit-spot', () => {
    for (const z of [0.5, 1, 1.5, 2]) {
      const exit = winRateFromZ(z, 'higher-lower');
      const nt = winRateFromZ(z, 'no-touch');
      expect(nt).toBeLessThan(exit);
      expect(nt).toBeGreaterThan(0);
    }
  });
  test('monotonically increasing', () => {
    const seq = [0.5, 1, 1.5, 2].map((z) => winRateFromZ(z, 'higher-lower'));
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThan(seq[i - 1]!);
  });
});

describe('estimateWinRates', () => {
  test('recovers the fixture means exactly', () => {
    const model = estimateWinRates(
      makeCandles({ days: 5, upRange: 2, dnRange: 1 }),
      BLOCK_START, BLOCK_END, 5,
    );
    expect(model).not.toBeNull();
    expect(model!.meanUp).toBeCloseTo(2, 9);
    expect(model!.meanDn).toBeCloseTo(1, 9);
    expect(model!.daysUsed).toBe(5);
  });

  test('uses only the same-TOD block, not the whole day', () => {
    // 5 days of history; the day-5 block looks back at days 4, 3, 2 — exactly
    // 3 same-TOD blocks, each with excursion 4. This proves the estimate
    // samples the same clock window, not the entire day.
    const model = estimateWinRates(
      makeCandles({ days: 5, upRange: 4, dnRange: 4 }),
      BLOCK_START, BLOCK_END, 3,
    );
    expect(model).not.toBeNull();
    expect(model!.daysUsed).toBe(3);
    expect(model!.meanUp).toBeCloseTo(4, 9);
  });

  test('null with no history', () => {
    expect(estimateWinRates([], BLOCK_START, BLOCK_END, 5)).toBeNull();
  });
});

// ─── Deterministic selector behaviour ────────────────────────────────────────

/**
 * A quote function that prices from OUR model rescaled by (1 + edge): the
 * house thinks vol is higher, so pays LESS for a stay-in-range win → EV for
 * us grows with the edge. Matches engine/dryRunPricing exactly.
 */
function houseQuote(edge: number, mode: 'higher-lower' | 'no-touch'): {
  candles: Candle[];
  model: ReturnType<typeof estimateWinRates>;
  quote: BandQuoteFn;
} {
  const candles = makeCandles({ days: 5, upRange: 2, dnRange: 2 });
  const model = estimateWinRates(candles, BLOCK_START, BLOCK_END, 5)!;
  return {
    candles,
    model,
    quote: async (req) => simulateQuote({
      trueP: req.trueP,
      distance: req.distance,
      sigmaBlock: req.sigmaBlock,
      mode,
      edge,
      stake: 1,
    }),
  };
}

function runSelect(edge: number, mode: 'higher-lower' | 'no-touch', minEv = 0, kCandidates = [1, 2, 3]) {
  const { candles, quote } = houseQuote(edge, mode);
  return selectBand({
    candles,
    blockStart: BLOCK_START,
    blockEnd: BLOCK_END,
    spot: SPOT,
    mode,
    kCandidates,
    minEv,
    lookbackDays: 5,
    quote,
  });
}

describe('selectBand — EV behaviour', () => {
  test('higher house edge raises EV at every K (monotone in edge)', async () => {
    const at = async (edge: number) => {
      const sel = await runSelect(edge, 'higher-lower');
      expect(sel).not.toBeNull();
      return new Map(sel!.candidates.map((c: BandCandidate) => [c.k, c.evBlock!]));
    };
    const e0 = await at(0);
    const e30 = await at(0.3);
    for (const k of [1, 2, 3]) {
      expect(e30.get(k)!).toBeGreaterThan(e0.get(k)!);
    }
  });

  test('with a positive edge the selector opens a block (EV > 0 somewhere)', async () => {
    const sel = await runSelect(0.3, 'higher-lower');
    expect(sel).not.toBeNull();
    expect(sel!.best).not.toBeNull();
    expect(sel!.best!.evBlock!).toBeGreaterThan(0);
    // EV is NOT monotone in K — the (trueP − impliedP) spread collapses at the
    // tail even though payout does too — so the best band is near the middle
    // of the grid, not the widest.
    expect(sel!.selectedK).not.toBeNull();
  });

  test('zero edge → EV ≈ 0 everywhere (fair house, no edge to find)', async () => {
    const sel = await runSelect(0, 'higher-lower');
    expect(sel).not.toBeNull();
    for (const c of sel!.candidates) expect(Math.abs(c.evBlock!)).toBeLessThan(0.005);
  });

  test('negative edge → every EV is negative, so the block is skipped', async () => {
    // edge<0 = the house thinks vol is lower than we do, so it prices the
    // stay-in-range win as MORE likely → pays LESS than fair → negative EV for
    // us at every K. The selector must refuse to trade.
    const sel = await runSelect(-0.3, 'higher-lower');
    expect(sel).not.toBeNull();
    for (const c of sel!.candidates) expect(c.evBlock!).toBeLessThan(0);
    expect(sel!.selectedK).toBeNull();
  });
});

describe('selectBand — skip-below-floor', () => {
  test('high floor skips the block when EV is small', async () => {
    // Edge 0.02 gives small-but-positive EV (≈0.01) that never reaches 1.5.
    const sel = await runSelect(0.02, 'higher-lower', 1.5);
    expect(sel).not.toBeNull();
    expect(sel!.selectedK).toBeNull();
  });

  test('minEv within reach selects the qualifying band', async () => {
    // Edge 0.3 tops out at ≈0.157 at K=1; a floor of 0.1 is within reach.
    const sel = await runSelect(0.3, 'higher-lower', 0.1);
    expect(sel).not.toBeNull();
    expect(sel!.selectedK).toBe(1);
  });
});

describe('selectBand — anchoring', () => {
  test('band is anchored at live spot, not block-open', async () => {
    // Block-open candle is 1000; spot drifted to 1002. Barriers must be
    // spot ± k·mean, so they reflect the drifted anchor.
    const { candles, quote } = houseQuote(0.3, 'higher-lower');
    const sel = await selectBand({
      candles,
      blockStart: BLOCK_START,
      blockEnd: BLOCK_END,
      spot: 1002,
      mode: 'higher-lower',
      kCandidates: [2],
      minEv: 0,
      lookbackDays: 5,
      quote,
    });
    expect(sel).not.toBeNull();
    const c = sel!.best!;
    expect(c.predHigh).toBeCloseTo(1002 + 2 * 2, 9);
    expect(c.predLow).toBeCloseTo(1002 - 2 * 2, 9);
    expect(sel!.blockOpen).toBe(1002);
  });
});

describe('selectBand — mode sensitivity', () => {
  test('no-touch trueP is lower at the same K (it needs a wider band to clear a win-rate)', async () => {
    const hl = await runSelect(0.2, 'higher-lower');
    const nt = await runSelect(0.2, 'no-touch');
    expect(hl).not.toBeNull();
    expect(nt).not.toBeNull();
    const hlK1 = hl!.candidates.find((c) => c.k === 1)!;
    const ntK1 = nt!.candidates.find((c) => c.k === 1)!;
    // Same distance from spot, but the intrabar-touch rule makes NO-TOUCH's
    // win rate strictly lower — that's the whole point of the mode split.
    expect(ntK1.truePUp).toBeLessThan(hlK1.truePUp);
    expect(ntK1.truePDn).toBeLessThan(hlK1.truePDn);
  });
});

describe('selectBand — model plumbing', () => {
  test('no same-TOD history → null (nothing to estimate from)', async () => {
    const sel = await selectBand({
      candles: [],
      blockStart: BLOCK_START,
      blockEnd: BLOCK_END,
      spot: SPOT,
      mode: 'higher-lower',
      kCandidates: [1, 2, 3],
      minEv: 0,
      lookbackDays: 5,
      quote: async () => null,
    });
    expect(sel).toBeNull();
  });
});

// ─── Phase 4 volatility regime ───────────────────────────────────────────────

describe('estimateWinRates — regime blend', () => {
  // makeCandles builds day-0..5 same-TOD candles with exact excursions.
  // The trailing 4 completed windows before BLOCK_START are day-4 blocks
  // 476..479 — rebuild those at a different range for a controlled blend.
  const HIST_UP = 2;
  const HIST_DN = 1;
  const RECENT_UP = 5;
  const RECENT_DN = 4;

  function candlesWithRecentRange(): Candle[] {
    const base = makeCandles({ days: 5, upRange: HIST_UP, dnRange: HIST_DN });
    const lastIdx = SECONDS_PER_DAY / BLOCK_SEC;
    const cutoff = 4 * SECONDS_PER_DAY + (lastIdx - 4) * BLOCK_SEC;
    const head = base.filter((c) => c.epoch < cutoff);
    const tail: Candle[] = [];
    for (let b = lastIdx - 4; b < lastIdx; b++) {
      const epoch = 4 * SECONDS_PER_DAY + b * BLOCK_SEC;
      tail.push({ epoch, open: 1000, high: 1000 + RECENT_UP, low: 1000 - RECENT_DN, close: 1000 });
    }
    return [...head, ...tail];
  }

  test('blends the means before calibrating σ', () => {
    const candles = candlesWithRecentRange();
    const base = estimateWinRates(candles, BLOCK_START, BLOCK_END, 5)!;
    expect(base.meanUp).toBeCloseTo(HIST_UP, 9);
    expect(base.meanDn).toBeCloseTo(HIST_DN, 9);
    const reg = estimateWinRates(candles, BLOCK_START, BLOCK_END, 5, { bars: 4, blend: 0.5 })!;
    const bUp = HIST_UP + 0.5 * (RECENT_UP - HIST_UP); // 3.5
    const bDn = HIST_DN + 0.5 * (RECENT_DN - HIST_DN); // 2.5
    expect(reg.meanUp).toBeCloseTo(bUp, 9);
    expect(reg.meanDn).toBeCloseTo(bDn, 9);
    // σ derives from the blended mean via the same fixed rescaling.
    expect(reg.sigmaUp).toBeCloseTo(bUp / Math.sqrt((2 * BLOCK_SEC) / Math.PI), 9);
  });

  test('blend 0 leaves the model untouched', () => {
    const candles = candlesWithRecentRange();
    const base = estimateWinRates(candles, BLOCK_START, BLOCK_END, 5)!;
    const reg = estimateWinRates(candles, BLOCK_START, BLOCK_END, 5, { bars: 4, blend: 0 })!;
    expect(reg).toEqual(base);
  });
});

describe('selectBand — regime vs house vol (the phantom-EV mechanism)', () => {
  /**
   * THE thesis: the house prices from RECENT realized vol while our model uses
   * the same-TOD mean. Blend 0 leaves our σ stale (low) → impliedP < trueP →
   * phantom EV at every K. Blend 1 makes our σ == house σ → EV ≈ 0 everywhere.
   * The quote fn below mirrors engine/backtest.ts: sigmaBlock = house σ·√T.
   */
  function houseQuoteFromRecent(recent: { up: number; dn: number }): BandQuoteFn {
    const k = Math.sqrt(Math.PI / 2);
    const houseSigma = { HIGHER: recent.up * k, LOWER: recent.dn * k };
    return async (req) => simulateQuote({
      trueP: req.trueP,
      distance: req.distance,
      sigmaBlock: houseSigma[req.side],
      mode: 'higher-lower',
      edge: 0,
      stake: 1,
    });
  }

  // Same-TOD mean 2.0/1.0; recent windows (last 4 before blockStart) run 5.0/4.0.
  const candles = (() => {
    const base = makeCandles({ days: 5, upRange: 2, dnRange: 1 });
    const lastIdx = SECONDS_PER_DAY / BLOCK_SEC;
    const cutoff = 4 * SECONDS_PER_DAY + (lastIdx - 4) * BLOCK_SEC;
    const head = base.filter((c) => c.epoch < cutoff);
    const tail: Candle[] = [];
    for (let b = lastIdx - 4; b < lastIdx; b++) {
      const epoch = 4 * SECONDS_PER_DAY + b * BLOCK_SEC;
      tail.push({ epoch, open: 1000, high: 1005, low: 996, close: 1000 });
    }
    return [...head, ...tail];
  })();
  const quote = houseQuoteFromRecent({ up: 5, dn: 4 });

  test('blend 0 → phantom positive EV (house sees higher vol than our stale model)', async () => {
    const sel = await selectBand({
      candles, blockStart: BLOCK_START, blockEnd: BLOCK_END, spot: SPOT,
      mode: 'higher-lower', kCandidates: [1, 2, 3], minEv: 0, lookbackDays: 5, quote,
    });
    expect(sel).not.toBeNull();
    expect(sel!.selectedK).not.toBeNull();
    expect(sel!.best!.evBlock!).toBeGreaterThan(0);
  });

  test('blend 1 → EV ≈ 0 for every K (our σ now tracks the house)', async () => {
    const sel = await selectBand({
      candles, blockStart: BLOCK_START, blockEnd: BLOCK_END, spot: SPOT,
      mode: 'higher-lower', kCandidates: [1, 2, 3], minEv: 0, lookbackDays: 5, quote,
      regime: { bars: 4, blend: 1 },
    });
    expect(sel).not.toBeNull();
    for (const c of sel!.candidates) expect(Math.abs(c.evBlock!)).toBeLessThan(0.005);
  });

  test('blend 0.7 shrinks the phantom but does not kill it', async () => {
    const phantom = await selectBand({
      candles, blockStart: BLOCK_START, blockEnd: BLOCK_END, spot: SPOT,
      mode: 'higher-lower', kCandidates: [1, 2, 3], minEv: 0, lookbackDays: 5, quote,
    });
    const partial = await selectBand({
      candles, blockStart: BLOCK_START, blockEnd: BLOCK_END, spot: SPOT,
      mode: 'higher-lower', kCandidates: [1, 2, 3], minEv: 0, lookbackDays: 5, quote,
      regime: { bars: 4, blend: 0.7 },
    });
    expect(phantom).not.toBeNull();
    expect(partial).not.toBeNull();
    const maxEv = (sel: typeof partial) => Math.max(...sel!.candidates.map((c) => c.evBlock!));
    // Blend 0.7 leaves our σ partway from stale→house: EV stays positive but is
    // strictly smaller than the blend-0 phantom (the house gap is narrower).
    expect(maxEv(partial)).toBeGreaterThan(0);
    expect(maxEv(partial)).toBeLessThan(maxEv(phantom));
  });
});

describe('winRateModelFromMeans', () => {
  test('per-tick vol derives from the mean excursion', () => {
    const m = winRateModelFromMeans(2, 2, 180, 5);
    // E[max] = σ·√(2T/π) ⇒ σ = 2 / √(2·180/π)
    expect(m.sigmaUp).toBeCloseTo(2 / Math.sqrt((2 * 180) / Math.PI), 6);
    expect(m.sigmaDn).toBeCloseTo(m.sigmaUp, 9);
  });
});
