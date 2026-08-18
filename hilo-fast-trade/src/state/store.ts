import { create } from 'zustand';
import type { HiLoConfig } from '../trading/config';

export type LogKind = 'system' | 'info' | 'warn' | 'error' | 'block' | 'trade-open' | 'trade-close' | 'sell' | 'status';

export interface LogLine {
  at: number;
  kind: LogKind;
  text: string;
}

export type LegSide = 'HIGHER' | 'LOWER';

export interface LegState {
  side: LegSide;
  contractId: number;
  stake: number;
  payout: number;
  buyPrice: number;
  barrier: number;
  liveProfit: number;
  bidPrice?: number;
  isValidToSell?: number;
  status: 'pending' | 'open' | 'won' | 'lost' | 'sold' | 'cancelled';
  resolved: boolean;
  /** Market-implied win probability (ask/payout) at quote time. */
  impliedP?: number;
  /** Independent estimate of the true win probability at quote time. */
  trueP?: number;
  /** Expected value at quote time = (trueP − impliedP) × payout (currency units). */
  ev?: number;
}

export type ExitReason = 'tp' | 'sl' | 'trail' | 'expiry' | 'cancel';

export interface PairState {
  blockStart: number;
  blockEnd: number;
  blockOpen: number;
  predictedHigh: number;
  predictedLow: number;
  predictionSource: 'historical' | 'atr';
  daysUsed: number;
  higher: LegState | null;
  lower: LegState | null;
  tpTriggered: boolean;
  /** Selected K in EV mode (for the ledger row). */
  evK?: number;
  /** How the block ended — set when an early exit fires, else 'expiry' at realise. */
  exitReason?: ExitReason;
}

export interface SessionState {
  startedAt: number;
  trades: number;
  wins: number;
  losses: number;
  /** Leg-level totals so the UI can show per-leg win rate separately from per-block outcome. */
  legsWon: number;
  legsLost: number;
  totalProfit: number;
  largestWin: number;
  largestLoss: number;
  /** Consecutive losing blocks — the circuit-breaker counter. */
  consecutiveLosses: number;
  /** Realised P&L since the UTC day boundary (seeded from the ledger at boot). */
  dayProfit: number;
  /** UTC date key ('YYYY-MM-DD') the dayProfit belongs to. */
  dayKey: string;
}

export interface AccountInfo {
  loginid?: string;
  type?: 'demo' | 'real';
  balance?: number;
  currency?: string;
}

export interface MenuItem {
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface MenuDefinition {
  title: string;
  items: MenuItem[];
}

export interface Store {
  config: HiLoConfig | null;
  status: 'idle' | 'connecting' | 'running' | 'halted' | 'error';
  halted: boolean;
  haltReason: string | null;
  account: AccountInfo;
  lastSpot: number | null;
  transcript: LogLine[];
  currentPair: PairState | null;
  history: PairState[];
  session: SessionState;
  menuStack: MenuDefinition[];

  setConfig(cfg: HiLoConfig): void;
  setStatus(s: Store['status']): void;
  halt(reason: string): void;
  unhalt(): void;
  resetSession(): void;
  setAccount(a: AccountInfo): void;
  setSpot(q: number): void;
  append(kind: LogKind, text: string): void;
  setPair(p: PairState): void;
  updateLeg(side: LegSide, patch: Partial<LegState>): void;
  markTpTriggered(reason?: ExitReason): void;
  finalisePair(): PairState | null;
  /** Restore a persisted session (state file on boot). */
  restoreSession(s: Partial<SessionState>): void;
  setSessionDay(dayProfit: number, dayKey: string): void;
  addSessionResult(profit: number, legs?: { won: number; lost: number }): void;
  clearTranscript(): void;
  pushMenu(m: MenuDefinition): void;
  popMenu(): void;
  clearMenus(): void;
  replaceTopMenu(m: MenuDefinition): void;
}

const MAX_TRANSCRIPT = 400;

function freshSession(): SessionState {
  return {
    startedAt: Date.now(),
    trades: 0,
    wins: 0,
    losses: 0,
    legsWon: 0,
    legsLost: 0,
    totalProfit: 0,
    largestWin: 0,
    largestLoss: 0,
    consecutiveLosses: 0,
    dayProfit: 0,
    dayKey: new Date().toISOString().slice(0, 10),
  };
}

export const useStore = create<Store>((set, get) => ({
  config: null,
  status: 'idle',
  halted: false,
  haltReason: null,
  account: {},
  lastSpot: null,
  transcript: [],
  currentPair: null,
  history: [],
  session: freshSession(),
  menuStack: [],

  setConfig: (cfg) => set({ config: cfg }),
  setStatus: (s) => set({ status: s }),
  halt: (reason) => set({ halted: true, haltReason: reason, status: 'halted' }),
  unhalt: () => set({ halted: false, haltReason: null, status: 'idle' }),
  resetSession: () => set({ session: freshSession() }),
  setAccount: (a) => set({ account: { ...get().account, ...a } }),
  setSpot: (q) => set({ lastSpot: q }),

  append: (kind, text) =>
    set((st) => {
      const line: LogLine = { at: Date.now(), kind, text };
      const next = st.transcript.length >= MAX_TRANSCRIPT
        ? [...st.transcript.slice(-MAX_TRANSCRIPT + 1), line]
        : [...st.transcript, line];
      return { transcript: next };
    }),

  setPair: (p) => set({ currentPair: p }),

  updateLeg: (side, patch) =>
    set((st) => {
      if (!st.currentPair) return {};
      const key = side === 'HIGHER' ? 'higher' : 'lower';
      const existing = st.currentPair[key];
      if (!existing) return {};
      const merged = { ...existing, ...patch } as LegState;
      return { currentPair: { ...st.currentPair, [key]: merged } };
    }),

  markTpTriggered: (reason) =>
    set((st) => (st.currentPair ? {
      currentPair: { ...st.currentPair, tpTriggered: true, ...(reason ? { exitReason: reason } : {}) },
    } : {})),

  setSessionDay: (dayProfit, dayKey) =>
    set((st) => ({ session: { ...st.session, dayProfit, dayKey } })),

  restoreSession: (s) =>
    set((st) => ({ session: { ...st.session, ...s } })),

  finalisePair: () => {
    const p = get().currentPair;
    if (!p) return null;
    set((st) => ({ currentPair: null, history: [...st.history, p].slice(-200) }));
    return p;
  },

  addSessionResult: (profit, legs = { won: 0, lost: 0 }) =>
    set((st) => {
      const s = st.session;
      const won = profit > 0;
      return {
        session: {
          ...s,
          trades: s.trades + 1,
          wins: s.wins + (won ? 1 : 0),
          losses: s.losses + (won ? 0 : 1),
          legsWon: s.legsWon + legs.won,
          legsLost: s.legsLost + legs.lost,
          totalProfit: s.totalProfit + profit,
          largestWin: profit > s.largestWin ? profit : s.largestWin,
          largestLoss: profit < s.largestLoss ? profit : s.largestLoss,
          consecutiveLosses: won ? 0 : s.consecutiveLosses + 1,
          dayProfit: s.dayProfit + profit,
        },
      };
    }),

  clearTranscript: () => set({ transcript: [] }),

  pushMenu: (m) => set((st) => ({ menuStack: [...st.menuStack, m] })),
  popMenu: () => set((st) => ({ menuStack: st.menuStack.slice(0, -1) })),
  clearMenus: () => set({ menuStack: [] }),
  replaceTopMenu: (m) =>
    set((st) => {
      if (st.menuStack.length === 0) return { menuStack: [m] };
      return { menuStack: [...st.menuStack.slice(0, -1), m] };
    }),
}));

export type StoreApi = typeof useStore;
