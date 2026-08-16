import { describe, expect, test } from 'bun:test';
import type { Candle } from '../services/derivWS/types';
import type { HiLoConfig } from '../trading/config';
import {
  aggregate,
  backtestBlock,
  resolveLeg,
  runBacktest,
  utcBlockStart,
  type BacktestBlockOutcome,
} from './backtest';

// 2027-01-01T00:00:00Z — a UTC-midnight so block alignment is exact.
const MIDNIGHT = 1_798_761_600;
const BLOCK_SEC = 180;

function candle(epoch: number, open: number, high: number, low: number, close: number): Candle {
  return { epoch, open, high, low, close };
}

function baseCfg(): HiLoConfig {
  return {
    appId: 'test',
    token: '',
    symbol: '1HZ100V',
    currency: 'USD',
    stake: 1,
    blockMinutes: 3,
    mode: 'higher-lower',
    blockTp: 1.5,
    blockSl: 0,
    blockTrail: 0,
    rangeMode: 'hybrid',
    lookbackDays: 4,
    atrBars: 14,
    rangeK: 1,
    evMode: false,
    kCandidates: [1, 1.5, 2],
    minEv: 0.3,
    evStagger: false,
    dryRun: true,
    skipContractCheck: true,
    noUi: true,
  };
}

/** ~6 days of deterministic 3-min bars. lookbackDays=4 so blocks past day 1 have history. */
function synthHistory(): Candle[] {
  const out: Candle[] = [];
  let price = 1000;
  let epoch = MIDNIGHT;
  const n = 6 * 480; // 6 days × 480 bars/day
  for (let i = 0; i < n; i++) {
    const open = price;
    const range = 0.4;
    const high = open + range;
    const low = open - range;
    const close = open + (i % 2 === 0 ? 0.1 : -0.1);
    out.push(candle(epoch, open, high, low, close));
    price = close;
    epoch += BLOCK_SEC;
  }
  return out;
}

describe('resolveLeg', () => {
  test('higher-lower upper leg wins when close stays below the barrier', () => {
    const r = resolveLeg('HIGHER', 1000.5, 1.9, 1, 'higher-lower', { high: 1001, low: 999, close: 1000.2 });
    expect(r.won).toBe(true);
    expect(r.profit).toBeCloseTo(0.9);
  });

  test('higher-lower upper leg loses when close breaches the barrier', () => {
    const r = resolveLeg('HIGHER', 1000.5, 1.9, 1, 'higher-lower', { high: 1001, low: 999, close: 1000.6 });
    expect(r.won).toBe(false);
    expect(r.profit).toBe(-1);
  });

  test('higher-lower lower leg wins when close stays above its barrier', () => {
    const r = resolveLeg('LOWER', 999.5, 1.9, 1, 'higher-lower', { high: 1001, low: 999, close: 1000.1 });
    expect(r.won).toBe(true);
  });

  test('no-touch upper leg loses on ANY intrabar touch even if close recovers', () => {
    const r = resolveLeg('HIGHER', 1000.5, 2.4, 1, 'no-touch', { high: 1000.5, low: 999, close: 1000.2 });
    expect(r.won).toBe(false);
  });

  test('no-touch upper leg wins when the high stays clear of the barrier', () => {
    const r = resolveLeg('HIGHER', 1000.5, 2.4, 1, 'no-touch', { high: 1000.4, low: 999, close: 999.8 });
    expect(r.won).toBe(true);
  });

  test('no-touch lower leg wins when the low stays above its barrier', () => {
    const r = resolveLeg('LOWER', 999.5, 2.4, 1, 'no-touch', { high: 1000.6, low: 999.6, close: 1000 });
    expect(r.won).toBe(true);
  });

  test('no-touch lower leg loses when the low touches its barrier', () => {
    const r = resolveLeg('LOWER', 999.5, 2.4, 1, 'no-touch', { high: 1000, low: 999.5, close: 1000 });
    expect(r.won).toBe(false);
  });
});

describe('backtestBlock (legacy fixed-K)', () => {
  test('replays history up to the block and resolves against the realised bar', async () => {
    const candles = synthHistory();
    const start = MIDNIGHT + 2 * 86400; // two days in → lookback has history
    const end = start + BLOCK_SEC;
    const blockCandles = [
      candle(start, 1000, 1000.3, 999.7, 1000.1),
      candle(start + 60, 1000.1, 1000.3, 999.8, 1000.05),
    ];
    const out = await backtestBlock({ candles, blockStart: start, blockEnd: end, blockCandles, cfg: baseCfg() });
    expect(out.skipped).toBe(false);
    expect(out.legs).toHaveLength(2);
    expect(out.predH).toBeGreaterThan(out.open);
    expect(out.predL).toBeLessThan(out.open);
    expect(out.pnl).toBe(out.legs[0]!.profit + out.legs[1]!.profit);
  });

  test('resolves no-touch against the realised high/low (touch → loss)', async () => {
    const candles = synthHistory();
    const start = MIDNIGHT + 3 * 86400;
    const end = start + BLOCK_SEC;
    const cfg = { ...baseCfg(), mode: 'no-touch' as const };
    // A bar that spikes above where predH sits (~open + K·meanUp ≈ 1000.4)
    // → the upper no-touch leg must lose, even though close is inside range.
    const blockCandles = [candle(start, 1000, 1000.5, 999.99, 1000.005)];
    const out = await backtestBlock({ candles, blockStart: start, blockEnd: end, blockCandles, cfg });
    expect(out.skipped).toBe(false);
    expect(out.high).toBeGreaterThan(out.predH);
    expect(out.legs.find((l) => l.side === 'HIGHER')!.won).toBe(false);
  });

  test('skips when there is no history for the prediction', async () => {
    const start = MIDNIGHT;
    const end = start + BLOCK_SEC;
    const out = await backtestBlock({
      candles: [],
      blockStart: start,
      blockEnd: end,
      blockCandles: [candle(start, 1000, 1000.5, 999.5, 1000.2)],
      cfg: { ...baseCfg(), rangeMode: 'historical' },
    });
    expect(out.skipped).toBe(true);
    expect(out.pnl).toBe(0);
  });
});

describe('backtestBlock (EV mode)', () => {
  test('skips when the best EV is below the floor (fair house → near-zero EV)', async () => {
    const candles = synthHistory();
    const start = MIDNIGHT + 4 * 86400;
    const end = start + BLOCK_SEC;
    const cfg = { ...baseCfg(), evMode: true, minEv: 0.3, backtestEdge: 0 };
    const out = await backtestBlock({
      candles,
      blockStart: start,
      blockEnd: end,
      blockCandles: [candle(start, 1000, 1000.4, 999.6, 1000.1)],
      cfg,
    });
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toMatch(/floor/);
  });

  test('trades when a positive house-edge makes EV reachable', async () => {
    const candles = synthHistory();
    const start = MIDNIGHT + 5 * 86400;
    const end = start + BLOCK_SEC;
    const cfg = { ...baseCfg(), evMode: true, minEv: 0.05, backtestEdge: 0.2 };
    const out = await backtestBlock({
      candles,
      blockStart: start,
      blockEnd: end,
      blockCandles: [candle(start, 1000, 1000.4, 999.6, 1000.1)],
      cfg,
    });
    expect(out.skipped).toBe(false);
    expect(out.evK).toBeGreaterThan(0);
    expect(out.legs).toHaveLength(2);
  });
});

describe('backtestBlock — Phase 4 regime (house prices from recent vol)', () => {
  /**
   * Deterministic vol-spike history: 6 days of range 0.4, then the last 30
   * block-windows before the block jump to range 3.0. Same-TOD mean stays low;
   * recent-realized vol is high. The house always prices from recent vol.
   */
  function spikeHistory(): Candle[] {
    const out: Candle[] = [];
    let price = 1000;
    let epoch = MIDNIGHT;
    const n = 6 * 480;
    for (let i = 0; i < n; i++) {
      const spike = i >= n - 30; // last 30 windows before the day-6 block
      const range = spike ? 3.0 : 0.4;
      const open = price;
      const high = open + range;
      const low = open - range;
      const close = open + (i % 2 === 0 ? 0.1 : -0.1);
      out.push(candle(epoch, open, high, low, close));
      price = close;
      epoch += BLOCK_SEC;
    }
    return out;
  }

  const start = MIDNIGHT + 6 * 86400;
  const end = start + BLOCK_SEC;
  const blockCandles = [candle(start, 1000, 1000.4, 999.6, 1000.1)];

  test('EV: blend 0 → phantom EV trades (house vol >> our stale model)', async () => {
    const cfg = { ...baseCfg(), evMode: true, minEv: 0.3, backtestEdge: 0 };
    const out = await backtestBlock({ candles: spikeHistory(), blockStart: start, blockEnd: end, blockCandles, cfg });
    expect(out.skipped).toBe(false);
    expect(out.legs[0]!.ev! + out.legs[1]!.ev!).toBeGreaterThan(0);
  });

  test('EV: blend 1 → EV ≈ 0, all blocks skipped', async () => {
    const cfg = { ...baseCfg(), evMode: true, minEv: 0.3, backtestEdge: 0, regimeBars: 24, regimeBlend: 1 };
    const out = await backtestBlock({ candles: spikeHistory(), blockStart: start, blockEnd: end, blockCandles, cfg });
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toMatch(/floor/);
  });

  test('EV: blend 0.7 → residual gap only (positive EV, below the 0.3 floor)', async () => {
    const cfg = { ...baseCfg(), evMode: true, minEv: 0.3, backtestEdge: 0, regimeBars: 24, regimeBlend: 0.7 };
    const out = await backtestBlock({ candles: spikeHistory(), blockStart: start, blockEnd: end, blockCandles, cfg });
    // Our σ is ~70% toward the house's → the phantom is small enough to skip.
    expect(out.skipped).toBe(true);
  });

  test('legacy: band adapts — predH is wider when recent vol is high + blend > 0', async () => {
    const base = await backtestBlock({ candles: spikeHistory(), blockStart: start, blockEnd: end, blockCandles, cfg: baseCfg() });
    const reg = await backtestBlock({
      candles: spikeHistory(), blockStart: start, blockEnd: end, blockCandles,
      cfg: { ...baseCfg(), regimeBars: 24, regimeBlend: 1 },
    });
    expect(base.skipped).toBe(false);
    expect(reg.skipped).toBe(false);
    // Blend 1 pulls the band to recent vol (3.0) — much wider than same-TOD (0.4).
    expect(reg.predH - reg.open).toBeGreaterThan(2 * (base.predH - base.open));
  });
});

describe('runBacktest / aggregate', () => {
  test('covers every UTC-aligned block with a realised candle and sums P&L', async () => {
    const candles = synthHistory();
    const res = await runBacktest({ candles, cfg: baseCfg() });
    expect(res.blocks.length).toBeGreaterThan(100);
    const expectedTotal = res.blocks.filter((b) => !b.skipped).reduce((s, b) => s + b.pnl, 0);
    expect(res.stats.totalPnl).toBeCloseTo(expectedTotal);
    expect(res.stats.traded + res.stats.skipped).toBe(res.stats.blocks);
    for (let i = 1; i < res.blocks.length; i++) {
      expect(res.blocks[i]!.blockStart).toBeGreaterThan(res.blocks[i - 1]!.blockStart);
    }
  });

  test('aggregate computes win rate, expectancy, drawdown and streak', () => {
    const blocks: BacktestBlockOutcome[] = [
      outcome(1, +1, [leg(true), leg(true)]),
      outcome(2, -1, [leg(false), leg(false)]),
      outcome(3, -1, [leg(false), leg(false)]),
      outcome(4, +1, [leg(true), leg(false)]),
      outcome(5, -1, [leg(false), leg(false)]),
    ];
    const s = aggregate(blocks);
    expect(s.blocks).toBe(5);
    expect(s.traded).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(3);
    expect(s.winRate).toBeCloseTo(0.4);
    expect(s.totalPnl).toBeCloseTo(-1);
    expect(s.expectancy).toBeCloseTo(-0.2);
    expect(s.maxConsecutiveLosses).toBe(2);
    // Equity: +1, 0, -1, 0, -1 → peak +1, max DD 2.
    expect(s.maxDrawdown).toBeCloseTo(2);
    // These synthetic legs carry no ev field, so evMeasured must be false.
    expect(s.evMeasured).toBe(false);
    expect(Number.isNaN(s.avgEv)).toBe(true);
  });

  test('aggregate profit factor and leg win rate', () => {
    const blocks: BacktestBlockOutcome[] = [
      outcome(1, +2, [leg(true), leg(true)]),
      outcome(2, -1, [leg(false), leg(false)]),
    ];
    const s = aggregate(blocks);
    expect(s.profitFactor).toBeCloseTo(2);
    expect(s.legsWon).toBe(2);
    expect(s.legsLost).toBe(2);
    expect(s.legWinRate).toBeCloseTo(0.5);
  });

  test('utcBlockStart floors to the UTC block grid', () => {
    expect(utcBlockStart(MIDNIGHT + 1, BLOCK_SEC)).toBe(MIDNIGHT);
    expect(utcBlockStart(MIDNIGHT + 179, BLOCK_SEC)).toBe(MIDNIGHT);
    expect(utcBlockStart(MIDNIGHT + BLOCK_SEC, BLOCK_SEC)).toBe(MIDNIGHT + BLOCK_SEC);
  });
});

function leg(won: boolean) {
  return {
    side: 'HIGHER' as const,
    barrier: 1000,
    stake: 1,
    payout: 1.9,
    impliedP: 0.5,
    won,
    profit: won ? 0.9 : -1,
  };
}

function outcome(blockStart: number, pnl: number, legs: ReturnType<typeof leg>[]): BacktestBlockOutcome {
  return {
    blockStart,
    blockEnd: blockStart + BLOCK_SEC,
    open: 1000,
    close: 1000,
    high: 1000.5,
    low: 999.5,
    predH: 1000.5,
    predL: 999.5,
    source: 'historical',
    skipped: false,
    legs,
    pnl,
  };
}
