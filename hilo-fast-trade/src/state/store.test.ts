import { describe, expect, test } from 'bun:test';
import { useStore } from './store';
import type { HiLoConfig } from '../trading/config';

const cfg = {
  appId: 'a',
  token: '',
  symbol: '1HZ100V',
  currency: 'USD',
  stake: 1,
  blockMinutes: 3,
  mode: 'higher-lower' as const,
  blockTp: 1.5,
  blockSl: 0,
  blockTrail: 0,
  rangeMode: 'hybrid' as const,
  lookbackDays: 20,
  atrBars: 14,
  rangeK: 1,
  evMode: false,
  kCandidates: [1, 2, 3],
  minEv: 0.3,
  evStagger: false,
  dryRun: true,
  skipContractCheck: false,
  noUi: true,
};

function seedSession(): void {
  const st = useStore.getState();
  st.setConfig(cfg as HiLoConfig);
  st.halt('test halt');
  st.addSessionResult(2.5, { won: 2, lost: 0 });
  st.addSessionResult(-1.0, { won: 0, lost: 2 });
}

describe('store halt / reset', () => {
  test('halt sets halted + status', () => {
    useStore.getState().halt('session TP hit');
    const s = useStore.getState();
    expect(s.halted).toBe(true);
    expect(s.status).toBe('halted');
    expect(s.haltReason).toBe('session TP hit');
  });

  test('unhalt clears halted and returns status to idle', () => {
    useStore.getState().halt('x');
    useStore.getState().unhalt();
    const s = useStore.getState();
    expect(s.halted).toBe(false);
    expect(s.haltReason).toBeNull();
    expect(s.status).toBe('idle');
  });

  test('resetSession zeroes stats but keeps config', () => {
    seedSession();
    useStore.getState().resetSession();
    const s = useStore.getState();
    expect(s.session.trades).toBe(0);
    expect(s.session.totalProfit).toBe(0);
    expect(s.session.legsWon).toBe(0);
    expect(s.config?.symbol).toBe('1HZ100V'); // config preserved
  });

  test('addSessionResult accumulates leg counts and profit', () => {
    seedSession();
    const s = useStore.getState().session;
    expect(s.trades).toBe(2);
    expect(s.legsWon).toBe(2);
    expect(s.legsLost).toBe(2);
    expect(s.totalProfit).toBeCloseTo(1.5, 6);
  });
});

describe('Phase 3 circuit-breaker counters', () => {
  test('consecutiveLosses resets on a win and accumulates on losses', () => {
    useStore.getState().resetSession();
    useStore.getState().addSessionResult(-1); // loss → 1
    useStore.getState().addSessionResult(-1); // loss → 2
    useStore.getState().addSessionResult(+2); // win  → 0
    useStore.getState().addSessionResult(-1); // loss → 1
    expect(useStore.getState().session.consecutiveLosses).toBe(1);
  });

  test('dayProfit accrues across results and dayKey is seeded', () => {
    useStore.getState().resetSession();
    useStore.getState().addSessionResult(+3);
    useStore.getState().addSessionResult(-1);
    expect(useStore.getState().session.dayProfit).toBeCloseTo(2);
    expect(useStore.getState().session.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('setSessionDay seeds the day counter from the ledger at boot', () => {
    useStore.getState().setSessionDay(-4.5, '2026-08-16');
    expect(useStore.getState().session.dayProfit).toBeCloseTo(-4.5);
    expect(useStore.getState().session.dayKey).toBe('2026-08-16');
  });
});
