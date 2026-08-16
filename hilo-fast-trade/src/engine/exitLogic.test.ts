import { describe, expect, test } from 'bun:test';
import {
  currentWinProb,
  evaluatePairExit,
  markToMarketProfit,
  newExitState,
  staggerStake,
  type ExitState,
} from './exitLogic';

function evalExit(s: ExitState, profit: number, over: Partial<Parameters<typeof evaluatePairExit>[0]> = {}) {
  return evaluatePairExit({
    state: s,
    profit,
    blockTp: 1.5,
    blockSl: 0,
    blockTrail: 0,
    trailArmAt: 0.75,
    ...over,
  });
}

describe('evaluatePairExit — hard TP', () => {
  test('sells at the TP gate', () => {
    const s = newExitState();
    expect(evalExit(s, 0.5).exit).toBe(false);
    expect(evalExit(s, 1.5).exit).toBe(true);
    expect(evalExit(s, 1.5).reason).toBe('tp');
  });

  test('TP disabled (0) never fires', () => {
    const s = newExitState();
    expect(evalExit(s, 99, { blockTp: 0 }).exit).toBe(false);
  });
});

describe('evaluatePairExit — block stop-loss', () => {
  test('sells below the SL line', () => {
    const s = newExitState();
    expect(evalExit(s, -0.5, { blockSl: 1 }).exit).toBe(false);
    const dec = evalExit(s, -1.0, { blockSl: 1 });
    expect(dec.exit).toBe(true);
    expect(dec.reason).toBe('sl');
  });

  test('SL disabled (0) never fires', () => {
    const s = newExitState();
    expect(evalExit(s, -10, { blockSl: 0 }).exit).toBe(false);
  });
});

describe('evaluatePairExit — trailing exit', () => {
  test('does not trail below the arming threshold', () => {
    const s = newExitState();
    // Peak reaches 0.7 (< armAt 0.75) then retraces 0.7 — still no trail.
    evalExit(s, 0.7, { blockTrail: 0.5 });
    const dec = evalExit(s, 0.2, { blockTrail: 0.5 });
    expect(dec.exit).toBe(false);
    expect(s.trailArmed).toBe(false);
  });

  test('arms at the threshold, then sells on the retrace', () => {
    const s = newExitState();
    expect(evalExit(s, 0.8, { blockTrail: 0.5 }).exit).toBe(false);
    expect(s.trailArmed).toBe(true);
    expect(s.peakPL).toBe(0.8);
    // Only 0.3 off the peak — hold.
    expect(evalExit(s, 0.5, { blockTrail: 0.5 }).exit).toBe(false);
    // 0.6 off the peak — trail fires.
    const dec = evalExit(s, 0.2, { blockTrail: 0.5 });
    expect(dec.exit).toBe(true);
    expect(dec.reason).toBe('trail');
  });

  test('peak only ever ratchets up', () => {
    const s = newExitState();
    evalExit(s, 2.0, { blockTrail: 1 });
    expect(s.peakPL).toBe(2.0);
    evalExit(s, 1.0, { blockTrail: 1 });
    expect(s.peakPL).toBe(2.0);
    evalExit(s, 2.5, { blockTrail: 1 });
    expect(s.peakPL).toBe(2.5);
  });

  test('trail disabled (0) never fires even after a big peak', () => {
    const s = newExitState();
    evalExit(s, 3.0, { blockTrail: 0, trailArmAt: 0 });
    const dec = evalExit(s, 0.0, { blockTrail: 0 });
    expect(dec.exit).toBe(false);
  });
});

describe('evaluatePairExit — precedence', () => {
  test('TP beats trail when both would fire', () => {
    const s = newExitState();
    // Peak 2.0 (armed), profit retraces to 1.5 which is exactly the TP.
    const dec = evalExit(s, 2.0, { blockTrail: 0.9 });
    expect(dec.reason).toBe('tp');
  });

  test('SL is independent of the peak (a losing pair still protects)', () => {
    const s = newExitState();
    evalExit(s, 0.6, { blockTrail: 0.4, blockSl: 1.5 }); // arms trail, small peak
    const dec = evalExit(s, -1.5, { blockTrail: 0.4, blockSl: 1.5 });
    expect(dec.exit).toBe(true);
    expect(dec.reason).toBe('sl');
  });
});

describe('staggerStake', () => {
  test('zero edge → base stake', () => {
    expect(staggerStake({ baseStake: 1, edge: 0 })).toBe(1);
  });

  test('positive edge → larger stake, bounded by maxRatio', () => {
    expect(staggerStake({ baseStake: 1, edge: 0.2 })).toBe(1.4);
    expect(staggerStake({ baseStake: 1, edge: 5 })).toBe(2); // clamped
  });

  test('negative edge → smaller stake, bounded by minRatio', () => {
    expect(staggerStake({ baseStake: 1, edge: -0.2 })).toBe(0.6);
    expect(staggerStake({ baseStake: 1, edge: -5 })).toBe(0.5); // clamped
  });

  test('rounds to cents and never to zero', () => {
    expect(staggerStake({ baseStake: 1, edge: 0.07 })).toBe(1.14);
    expect(staggerStake({ baseStake: 0.5, edge: -5 })).toBe(0.25);
    // 0.05 × 0.5 = 0.025 → rounds to 0.03; the floor must keep it > 0.
    expect(staggerStake({ baseStake: 0.05, edge: -5 })).toBeGreaterThan(0);
  });
});

describe('currentWinProb + markToMarketProfit (dry-run mark-to-market)', () => {
  test('at entry the prob matches winRateFromZ (distance / σ·√fullT)', () => {
    const { winRateFromZ } = require('./bandSelector');
    // σ·√T = 2 (block vol), distance 2 → z=1 at entry (secsRemaining = ticks).
    const p = currentWinProb({ distance: 2, sigmaPerTick: 2 / Math.sqrt(100), secondsRemaining: 100, mode: 'higher-lower' });
    expect(p).toBeCloseTo(winRateFromZ(1, 'higher-lower'), 6);
  });

  test('probability rises toward 1 as the barrier drifts out of reach', () => {
    const p = currentWinProb({ distance: 10, sigmaPerTick: 0.1, secondsRemaining: 1, mode: 'higher-lower' });
    expect(p).toBeGreaterThan(0.9);
  });

  test('no-touch collapses toward 0 as the barrier is nearly touched', () => {
    const p = currentWinProb({ distance: 0.01, sigmaPerTick: 0.1, secondsRemaining: 1, mode: 'no-touch' });
    expect(p).toBeLessThan(0.1);
  });

  test('markToMarketProfit is EV of the remaining bet', () => {
    // payout 1.8, stake 1, winP 0.8 → +0.8·0.8 − 1·0.2 = +0.44
    expect(markToMarketProfit({ payout: 1.8, stake: 1, currentWinP: 0.8 })).toBeCloseTo(0.44, 6);
    // winP 0.2 → +0.8·0.2 − 1·0.8 = −0.64
    expect(markToMarketProfit({ payout: 1.8, stake: 1, currentWinP: 0.2 })).toBeCloseTo(-0.64, 6);
  });
});
