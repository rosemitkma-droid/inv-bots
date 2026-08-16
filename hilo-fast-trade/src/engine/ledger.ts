/**
 * Phase 3 — persistent equity ledger.
 *
 * A durable, append-only CSV of block outcomes so the session view survives
 * restarts: equity / daily P&L come from real recorded trades, not from a
 * fresh counter each run. Writing is append-only (one row per realised block);
 * reading only ever happens at boot to seed the session's day counter.
 *
 * Layout: one row per BLOCK (the unit of capital risk), each row carrying the
 * block's prediction, the two leg outcomes, the combined P&L, and the running
 * session P&L. The `--ledger <path>` flag / `HILO_LEDGER` env turn it on.
 */

import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerExit = 'tp' | 'sl' | 'trail' | 'expiry' | 'cancel';

export interface LedgerRow {
  /** Epoch seconds of the block start (UTC). */
  at: number;
  block: string;
  mode: string;
  source: string;
  daysUsed: number;
  evK?: number;
  open: number;
  predH: number;
  predL: number;
  exit: LedgerExit;
  pnlUp: number;
  pnlDn: number;
  pnlBlock: number;
  /** Cumulative session P&L after this block. */
  sessionPnl: number;
}

export const LEDGER_COLUMNS = [
  'at', 'block', 'mode', 'source', 'days_used', 'ev_k', 'open', 'pred_h',
  'pred_l', 'exit', 'pnl_up', 'pnl_dn', 'pnl_block', 'session_pnl',
] as const;

export function ledgerHeader(): string {
  return LEDGER_COLUMNS.join(',');
}

/** Escape a CSV field (defensive — every field is a number or simple string). */
function esc(v: string | number | undefined): string {
  const s = v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function ledgerRow(r: LedgerRow): string {
  return [
    r.at, r.block, r.mode, r.source, r.daysUsed, r.evK ?? '', r.open, r.predH,
    r.predL, r.exit, r.pnlUp, r.pnlDn, r.pnlBlock, r.sessionPnl,
  ].map(esc).join(',');
}

export function parseLedger(text: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line === ledgerHeader()) continue;
    const c = line.split(',');
    if (c.length < LEDGER_COLUMNS.length) continue;
    const n = (i: number): number => Number(c[i] ?? NaN);
    out.push({
      at: n(0),
      block: c[1] ?? '',
      mode: c[2] ?? '',
      source: c[3] ?? '',
      daysUsed: n(4),
      evK: c[5] === '' ? undefined : n(5),
      open: n(6),
      predH: n(7),
      predL: n(8),
      exit: (c[9] ?? 'expiry') as LedgerExit,
      pnlUp: n(10),
      pnlDn: n(11),
      pnlBlock: n(12),
      sessionPnl: n(13),
    });
  }
  return out;
}

/** Append one row, creating the file + header on first write. */
export function appendLedgerRow(path: string, row: LedgerRow): void {
  const first = !fileExists(path);
  if (first) {
    // Only mkdir when the path has a real directory component — mkdirSync('.')
    // throws EEXIST on some platforms (Windows/Bun), and the CWD already exists.
    const parent = dirname(path);
    if (parent && parent !== '.') mkdirSync(parent, { recursive: true });
    appendFileSync(path, ledgerHeader() + '\n');
  }
  appendFileSync(path, ledgerRow(row) + '\n');
}

/** Load all rows (empty array when the file is missing or unreadable). */
export function loadLedger(path: string): LedgerRow[] {
  try {
    return parseLedger(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Sum of block P&L whose `at` falls on the given UTC date key. */
export function ledgerDayPnl(rows: LedgerRow[], dayKey: string): number {
  let sum = 0;
  for (const r of rows) {
    if (utcDayKey(r.at) === dayKey) sum += r.pnlBlock;
  }
  return sum;
}

/** 'YYYY-MM-DD' in UTC for an epoch-seconds timestamp. */
export function utcDayKey(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}
