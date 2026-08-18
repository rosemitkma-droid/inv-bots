/**
 * State persistence — saves session stats to a JSON file so they survive
 * reconnects, restarts, and server reboots. The file is written on every
 * trade result and restored on boot.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionState } from './store';

interface PersistedState {
  /** UTC date key ('YYYY-MM-DD') this state belongs to. */
  dayKey: string;
  /** Number of completed blocks. */
  trades: number;
  wins: number;
  losses: number;
  /** Leg-level totals. */
  legsWon: number;
  legsLost: number;
  /** Cumulative session P&L (all-time during this session). */
  totalProfit: number;
  largestWin: number;
  largestLoss: number;
  /** Consecutive losing blocks — the circuit-breaker counter. */
  consecutiveLosses: number;
  /** Realised P&L since the UTC day boundary. */
  dayProfit: number;
  /** ISO timestamp of last save. */
  savedAt: string;
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load session state from disk. Returns null when the file is missing,
 * unreadable, or belongs to a different UTC day (session reset on new day).
 */
export function loadState(path: string): Partial<SessionState> | null {
  if (!path || !fileExists(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as PersistedState;
    const today = new Date().toISOString().slice(0, 10);
    // State from a previous day is stale — start fresh.
    if (data.dayKey !== today) return null;
    return {
      startedAt: Date.now(),
      trades: data.trades ?? 0,
      wins: data.wins ?? 0,
      losses: data.losses ?? 0,
      legsWon: data.legsWon ?? 0,
      legsLost: data.legsLost ?? 0,
      totalProfit: data.totalProfit ?? 0,
      largestWin: data.largestWin ?? 0,
      largestLoss: data.largestLoss ?? 0,
      consecutiveLosses: data.consecutiveLosses ?? 0,
      dayProfit: data.dayProfit ?? 0,
      dayKey: data.dayKey,
    };
  } catch {
    return null;
  }
}

/**
 * Save session state to disk. Creates the file and parent directories on
 * first write. Failures are silently swallowed — persistence is best-effort.
 */
export function saveState(path: string, session: SessionState): void {
  if (!path) return;
  try {
    const parent = dirname(path);
    if (parent && parent !== '.') mkdirSync(parent, { recursive: true });
    const data: PersistedState = {
      dayKey: session.dayKey,
      trades: session.trades,
      wins: session.wins,
      losses: session.losses,
      legsWon: session.legsWon,
      legsLost: session.legsLost,
      totalProfit: session.totalProfit,
      largestWin: session.largestWin,
      largestLoss: session.largestLoss,
      consecutiveLosses: session.consecutiveLosses,
      dayProfit: session.dayProfit,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  } catch {
    // Best-effort — don't break the trading loop over persistence.
  }
}
