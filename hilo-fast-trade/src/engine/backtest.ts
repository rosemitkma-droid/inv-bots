/**
 * Phase 3 — replay backtester.
 *
 * Replays candle history block-by-block exactly the way the live bot trades:
 * at each UTC-aligned block boundary, form the band from the candles that
 * existed up to that moment (no future peeking), resolve each leg against the
 * block's OWN realised high/low/close, and aggregate the outcomes into honest
 * statistics — win rate, P&L, expectancy, drawdown.
 *
 * This is the measurement harness for the whole upgrade thesis: on a driftless
 * synthetic, a stay-in-range pair with a fair house (backtestEdge = 0) should
 * show EV ≈ 0 and win rate ≈ break-even; a real edge (measured live, or
 * modelled by a house that mis-prices vol) is what separates profit from noise.
 *
 * What it replays faithfully:
 *   - legacy fixed-K band (predictRange) and EV-first selection (selectBand),
 *     each run against only the history available at block start;
 *   - the block's open as entry spot, its close as the HIGHER/LOWER exit spot,
 *     and its full high/low as the NOTOUCH intrabar range;
 *   - a simulated house quote (simulateQuote) so every leg carries a payout and
 *     impliedP, just like the live/dry-run proposal path.
 *
 * What it does NOT model: intrabar early exits (TP/SL/trail). Those are a
 * risk-management overlay that only becomes realisable in a live tick stream —
 * at block granularity we can only see the ride-to-expiry outcome, which is
 * the honest baseline the overlay is meant to protect.
 */

import type { Candle } from '../services/derivWS/types';
import type { HiLoConfig } from '../trading/config';
import { DEFAULT_REGIME_BARS } from '../constants/api';
import { predictRange } from './rangePredictor';
import { legSigmaBlock, selectBand, winRateModelFromMeans, winRate } from './bandSelector';
import { simulateQuote } from './dryRunPricing';
import { recentExcursions, regimeFromConfig } from './regime';

export type BacktestLegSide = 'HIGHER' | 'LOWER';

export interface BacktestLeg {
  side: BacktestLegSide;
  barrier: number;
  stake: number;
  payout: number;
  impliedP: number;
  trueP?: number;
  ev?: number;
  won: boolean;
  profit: number;
}

export interface BacktestBlockOutcome {
  blockStart: number;
  blockEnd: number;
  open: number;
  close: number;
  high: number;
  low: number;
  predH: number;
  predL: number;
  source: 'historical' | 'atr';
  evK?: number;
  /** True when the block was skipped (no band formed / below EV floor). */
  skipped: boolean;
  skipReason?: string;
  legs: BacktestLeg[];
  pnl: number;
}

export interface BacktestStats {
  /** UTC-aligned blocks that had a realised candle. */
  blocks: number;
  /** Blocks with no band to trade (no history, or EV floor not met). */
  skipped: number;
  /** Blocks that opened a pair. */
  traded: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  /** Mean P&L per traded block. */
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  /** Gross profit / |gross loss| over traded blocks. */
  profitFactor: number;
  /** Peak-to-trough drop of the cumulative P&L curve. */
  maxDrawdown: number;
  maxConsecutiveLosses: number;
  legsWon: number;
  legsLost: number;
  legWinRate: number;
  /** Mean combined per-leg EV over traded blocks (NaN when no model existed). */
  avgEv: number;
  /** True when at least one leg carried an EV estimate (model + quote present). */
  evMeasured: boolean;
}

export interface BacktestResult {
  stats: BacktestStats;
  blocks: BacktestBlockOutcome[];
}

/**
 * Resolve one leg's win/loss + P&L against the block's realised bar.
 *
 *   higher-lower: exit-spot rule — the leg bets price STAYS in range, so the
 *                 upper leg (barrier predH) wins iff close < predH and the
 *                 lower leg (barrier predL) wins iff close > predL.
 *   no-touch:     any intrabar touch loses — upper wins iff the block's high
 *                 stayed below predH, lower iff its low stayed above predL.
 */
export function resolveLeg(
  side: BacktestLegSide,
  barrier: number,
  payout: number,
  stake: number,
  mode: HiLoConfig['mode'],
  block: { high: number; low: number; close: number },
): { won: boolean; profit: number } {
  let won: boolean;
  if (mode === 'no-touch') {
    won = side === 'HIGHER' ? block.high < barrier : block.low > barrier;
  } else {
    won = side === 'HIGHER' ? block.close < barrier : block.close > barrier;
  }
  return { won, profit: won ? payout - stake : -stake };
}

export interface BacktestBlockArgs {
  candles: Candle[];
  blockStart: number;
  blockEnd: number;
  /** The realised bar(s) for this block — used for outcomes, never for the band. */
  blockCandles: Candle[];
  cfg: Pick<
    HiLoConfig,
    'mode' | 'rangeMode' | 'lookbackDays' | 'atrBars' | 'rangeK' | 'evMode' | 'kCandidates' | 'minEv' | 'stake' | 'backtestEdge' | 'dryRunEdge' | 'regimeBars' | 'regimeBlend'
  >;
}

/**
 * Per-side σ·√T the simulated house prices from — recent realized vol, measured
 * as the mean up/dn block excursion over the last `regime.bars` windows. This is
 * the same transformation legSigmaBlock applies to a model's mean excursion:
 * σ·√T = E[max]·√(π/2). The house prices from RECENT vol regardless of how much
 * of it OUR model blends in — that gap is exactly the phantom-EV mechanism the
 * regime blend closes. Null → caller falls back to the model's σ (warmup).
 */
function houseSigmaFromRecent(recent: { up: number; dn: number } | null): { HIGHER: number; LOWER: number } | null {
  if (!recent) return null;
  const k = Math.sqrt(Math.PI / 2);
  return { HIGHER: recent.up * k, LOWER: recent.dn * k };
}

/** Form the band for one block and resolve its two legs. Pure / deterministic. */
export async function backtestBlock(args: BacktestBlockArgs): Promise<BacktestBlockOutcome> {
  const { candles, blockStart, blockEnd, blockCandles, cfg } = args;
  const blockSec = blockEnd - blockStart;
  const open = blockCandles[0]!.open;
  const close = blockCandles[blockCandles.length - 1]!.close;
  let high = -Infinity;
  let low = Infinity;
  for (const c of blockCandles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  const block = { high, low, close };
  const mode = cfg.mode;
  const edge = cfg.backtestEdge ?? 0;
  const stake = cfg.stake;

  // Phase 4. The simulated house ALWAYS prices from recent realized vol (its
  // own estimate), regardless of how much of it OUR model blends in — that gap
  // is exactly the phantom-EV mechanism the regime blend closes. On stationary
  // history recent == same-TOD, so this is numerically identical to Phase 3.
  const houseBars = cfg.regimeBars ?? DEFAULT_REGIME_BARS;
  const houseSigma = houseSigmaFromRecent(recentExcursions(candles, blockStart, blockEnd, houseBars));
  const regime = regimeFromConfig(cfg);

  // EV-first path: quote the candidate grid through the simulated house and pick
  // the highest-EV band. Duration is the FULL block (replay has no "now").
  if (cfg.evMode) {
    const sel = await selectBand({
      candles,
      blockStart,
      blockEnd,
      spot: open,
      mode,
      kCandidates: cfg.kCandidates,
      minEv: cfg.minEv,
      lookbackDays: cfg.lookbackDays,
      durationSec: blockSec,
      regime,
      quote: (req) => {
        const sim = simulateQuote({
          trueP: req.trueP,
          distance: req.distance,
          sigmaBlock: houseSigma?.[req.side] ?? req.sigmaBlock,
          mode,
          edge,
          stake,
        });
        return Promise.resolve({ payout: sim.payout, impliedP: sim.impliedP });
      },
    });
    if (!sel) {
      return skipOutcome(blockStart, blockEnd, open, high, low, close, 'historical', 'no same-TOD history');
    }
    const chosen = sel.best;
    if (sel.selectedK === null || !chosen) {
      return skipOutcome(blockStart, blockEnd, open, high, low, close, 'historical',
        `best EV ${sel.best?.evBlock?.toFixed(2) ?? '?'} below floor ${cfg.minEv.toFixed(2)}`);
    }
    const predH = chosen.predHigh;
    const predL = chosen.predLow;
    const upper: BacktestLeg = {
      side: 'HIGHER', barrier: predH, stake,
      payout: chosen.payoutUp!,
      impliedP: chosen.impliedPUp!,
      trueP: chosen.truePUp,
      ev: chosen.evUp,
      ...resolveLeg('HIGHER', predH, chosen.payoutUp!, stake, mode, block),
    };
    const lower: BacktestLeg = {
      side: 'LOWER', barrier: predL, stake,
      payout: chosen.payoutDn!,
      impliedP: chosen.impliedPDn!,
      trueP: chosen.truePDn,
      ev: chosen.evDn,
      ...resolveLeg('LOWER', predL, chosen.payoutDn!, stake, mode, block),
    };
    const legs = [upper, lower];
    return {
      blockStart, blockEnd, open, close, high, low,
      predH, predL, source: 'historical', evK: chosen.k,
      skipped: false, legs, pnl: legs[0]!.profit + legs[1]!.profit,
    };
  }

  // Legacy fixed-K path.
  const pred = predictRange(candles, blockStart, blockEnd, open, {
    mode: cfg.rangeMode,
    lookbackDays: cfg.lookbackDays,
    atrBars: cfg.atrBars,
    k: cfg.rangeK,
    granularitySec: blockSec,
    regime,
  });
  if (!pred) {
    return skipOutcome(blockStart, blockEnd, open, high, low, close, 'historical', 'no prediction (need more history)');
  }

  const model = pred.meanUp !== undefined && pred.meanDown !== undefined
    ? winRateModelFromMeans(pred.meanUp, pred.meanDown, blockSec, pred.daysUsed)
    : null;

  const legs: BacktestLeg[] = [];
  const mkLeg = (side: BacktestLegSide, barrier: number): void => {
    const distance = Math.abs(barrier - open);
    const trueP = model ? winRate(model, mode, side, distance) : undefined;
    const sim = model && trueP !== undefined
      ? simulateQuote({
          trueP, distance,
          sigmaBlock: houseSigma?.[side] ?? legSigmaBlock(model, side),
          mode, edge, stake,
        })
      : { impliedP: 1 / 1.95, payout: stake * 1.95 };
    const res = resolveLeg(side, barrier, sim.payout, stake, mode, block);
    legs.push({
      side, barrier, stake, payout: sim.payout, impliedP: sim.impliedP,
      trueP,
      ev: trueP !== undefined ? (trueP - sim.impliedP) * sim.payout : undefined,
      ...res,
    });
  };
  mkLeg('HIGHER', pred.predictedHigh);
  mkLeg('LOWER', pred.predictedLow);

  return {
    blockStart, blockEnd, open, close, high, low,
    predH: pred.predictedHigh, predL: pred.predictedLow,
    source: pred.source,
    skipped: false, legs, pnl: legs[0]!.profit + legs[1]!.profit,
  };
}

function skipOutcome(
  blockStart: number,
  blockEnd: number,
  open: number,
  high: number,
  low: number,
  close: number,
  source: 'historical' | 'atr',
  skipReason: string,
): BacktestBlockOutcome {
  return {
    blockStart, blockEnd, open, close, high, low,
    predH: 0, predL: 0, source, skipped: true, skipReason, legs: [], pnl: 0,
  };
}

export interface RunBacktestArgs {
  candles: Candle[];
  cfg: HiLoConfig;
}

/**
 * Walk every UTC-aligned block that has a realised candle, trade it, and
 * aggregate. Candles are assumed ascending by epoch (the caller sorts).
 */
export async function runBacktest(args: RunBacktestArgs): Promise<BacktestResult> {
  const { candles, cfg } = args;
  const blockSec = cfg.blockMinutes * 60;
  const blocks: BacktestBlockOutcome[] = [];
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return { stats: emptyStats(), blocks: [] };

  const firstBlockStart = utcBlockStart(first.epoch, blockSec);
  const lastBlockStart = utcBlockStart(last.epoch, blockSec);

  for (let start = firstBlockStart; start <= lastBlockStart; start += blockSec) {
    const end = start + blockSec;
    const blockCandles = candles.filter((c) => c.epoch >= start && c.epoch < end);
    if (blockCandles.length === 0) continue;
    const history = candles.filter((c) => c.epoch < start);
    blocks.push(await backtestBlock({ candles: history, blockStart: start, blockEnd: end, blockCandles, cfg }));
  }

  return { stats: aggregate(blocks), blocks };
}

function emptyStats(): BacktestStats {
  return {
    blocks: 0, skipped: 0, traded: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, expectancy: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
    maxDrawdown: 0, maxConsecutiveLosses: 0, legsWon: 0, legsLost: 0,
    legWinRate: 0, avgEv: Number.NaN, evMeasured: false,
  };
}

export function aggregate(blocks: BacktestBlockOutcome[]): BacktestStats {
  const s = emptyStats();
  s.blocks = blocks.length;
  const traded = blocks.filter((b) => !b.skipped);
  s.skipped = blocks.length - traded.length;
  s.traded = traded.length;

  let equity = 0;
  let peak = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let evSum = 0;
  let evCount = 0;
  let streak = 0;

  for (const b of traded) {
    equity += b.pnl;
    s.totalPnl += b.pnl;
    if (b.pnl > 0) {
      s.wins++;
      grossProfit += b.pnl;
      streak = 0;
    } else if (b.pnl < 0) {
      s.losses++;
      grossLoss += -b.pnl;
      streak++;
      if (streak > s.maxConsecutiveLosses) s.maxConsecutiveLosses = streak;
    }
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;
    for (const l of b.legs) {
      if (l.won) s.legsWon++;
      else s.legsLost++;
      if (l.ev !== undefined && Number.isFinite(l.ev)) {
        evSum += l.ev;
        evCount++;
      }
    }
  }

  const n = s.traded;
  if (n > 0) {
    s.winRate = s.wins / n;
    s.expectancy = s.totalPnl / n;
    s.avgWin = s.wins ? grossProfit / s.wins : 0;
    s.avgLoss = s.losses ? -grossLoss / s.losses : 0;
    s.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    s.legWinRate = s.legsWon + s.legsLost ? s.legsWon / (s.legsWon + s.legsLost) : 0;
    s.evMeasured = evCount > 0;
    s.avgEv = evCount ? evSum / evCount : Number.NaN;
  }
  return s;
}

/** UTC-aligned block start for an epoch timestamp (matches BlockClock's floor). */
export function utcBlockStart(epochSec: number, blockSec: number): number {
  return Math.floor(epochSec / blockSec) * blockSec;
}
