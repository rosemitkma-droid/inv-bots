import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLedgerRow,
  ledgerDayPnl,
  ledgerHeader,
  ledgerRow,
  loadLedger,
  parseLedger,
  utcDayKey,
  type LedgerRow,
} from './ledger';

// 2027-01-01T00:00:00Z.
const MIDNIGHT = 1_798_761_600;

function row(at: number, pnl: number): LedgerRow {
  return {
    at,
    block: new Date(at * 1000).toISOString().slice(11, 16) + 'Z',
    mode: 'higher-lower',
    source: 'historical',
    daysUsed: 4,
    open: 1000,
    predH: 1000.4,
    predL: 999.6,
    exit: 'expiry',
    pnlUp: pnl / 2,
    pnlDn: pnl / 2,
    pnlBlock: pnl,
    sessionPnl: pnl,
  };
}

describe('CSV row', () => {
  test('header matches the column list', () => {
    expect(ledgerHeader()).toBe('at,block,mode,source,days_used,ev_k,open,pred_h,pred_l,exit,pnl_up,pnl_dn,pnl_block,session_pnl');
  });

  test('round-trips through parseLedger including ev_k and exit', () => {
    const r: LedgerRow = { ...row(MIDNIGHT, +1.5), evK: 2, exit: 'tp' };
    const [parsed] = parseLedger(ledgerRow(r));
    expect(parsed.at).toBe(MIDNIGHT);
    expect(parsed.mode).toBe('higher-lower');
    expect(parsed.evK).toBe(2);
    expect(parsed.exit).toBe('tp');
    expect(parsed.pnlBlock).toBeCloseTo(1.5);
    expect(parsed.sessionPnl).toBeCloseTo(1.5);
  });

  test('missing ev_k parses as undefined and exit defaults to expiry', () => {
    const [parsed] = parseLedger(ledgerRow(row(MIDNIGHT, -2)));
    expect(parsed.evK).toBeUndefined();
    expect(parsed.exit).toBe('expiry');
  });

  test('header line is skipped on parse', () => {
    const rows = parseLedger(ledgerHeader() + '\n' + ledgerRow(row(MIDNIGHT, 1)) + '\n');
    expect(rows).toHaveLength(1);
  });

  test('garbage lines are skipped', () => {
    expect(parseLedger('not,a,ledger\n' + ledgerRow(row(MIDNIGHT, 1)))).toHaveLength(1);
  });
});

describe('file I/O', () => {
  test('appendLedgerRow creates the file with header on first write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilo-ledger-'));
    const path = join(dir, 'sub', 'ledger.csv');
    try {
      appendLedgerRow(path, row(MIDNIGHT, 3));
      appendLedgerRow(path, row(MIDNIGHT + 180, -1));
      const text = readFileSync(path, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      expect(lines[0]).toBe(ledgerHeader());
      expect(lines).toHaveLength(3);
      expect(loadLedger(path)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadLedger returns [] for a missing file', () => {
    expect(loadLedger(join(tmpdir(), 'hilo-does-not-exist.csv'))).toEqual([]);
  });

  test('loadLedger returns [] for unreadable content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilo-ledger-'));
    const path = join(dir, 'bad.csv');
    try {
      // Write binary garbage.
      writeFileSync(path, Buffer.from([0, 1, 2, 3]));
      expect(loadLedger(path)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('day accounting', () => {
  test('utcDayKey formats an epoch as YYYY-MM-DD in UTC', () => {
    expect(utcDayKey(MIDNIGHT)).toBe('2027-01-01');
    expect(utcDayKey(MIDNIGHT + 86_400)).toBe('2027-01-02');
    expect(utcDayKey(MIDNIGHT - 1)).toBe('2026-12-31');
  });

  test('ledgerDayPnl sums only rows on the given day', () => {
    const rows = [
      row(MIDNIGHT, +2),
      row(MIDNIGHT + 3600, -1),
      row(MIDNIGHT + 86_400, +5), // next day
      row(MIDNIGHT - 60, -4),     // previous day
    ];
    expect(ledgerDayPnl(rows, '2027-01-01')).toBeCloseTo(1);
    expect(ledgerDayPnl(rows, '2027-01-02')).toBeCloseTo(5);
    expect(ledgerDayPnl(rows, '2026-12-31')).toBeCloseTo(-4);
  });
});
