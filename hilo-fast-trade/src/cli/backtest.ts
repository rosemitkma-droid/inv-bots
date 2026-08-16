/**
 * `--backtest` entry point: load candle history (from --csv, else live Deriv),
 * replay it block-by-block, and print a win-rate / P&L / expectancy summary.
 * Exits after printing — no TUI, no trading.
 */

import { readFileSync } from 'node:fs';
import type { Candle } from '../services/derivWS/types';
import { runBacktest, type BacktestStats } from '../engine/backtest';
import { DerivWS } from '../services/derivWS';
import { blockSeconds, type HiLoConfig } from '../trading/config';
import { DEFAULT_APP_ID } from '../constants/api';

/** Parse a 5-column OHLC CSV (epoch,open,high,low,close), sorting by epoch. */
export function parseOhlcCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 5) continue;
    const epoch = Number(c[0]);
    const open = Number(c[1]);
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (!Number.isFinite(epoch) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close) || epoch <= 0) {
      continue;
    }
    out.push({ epoch, open, high, low, close });
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

async function loadCandles(cfg: HiLoConfig): Promise<Candle[]> {
  if (cfg.csv) {
    let text: string;
    try {
      text = readFileSync(cfg.csv, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot read --csv '${cfg.csv}': ${msg}`);
    }
    const candles = parseOhlcCsv(text);
    if (candles.length < 2) {
      throw new Error(`--csv '${cfg.csv}' has < 2 usable OHLC rows (expect epoch,open,high,low,close)`);
    }
    return candles;
  }

  const ws = new DerivWS({
    appId: cfg.appId || DEFAULT_APP_ID,
    token: cfg.token,
    accountId: cfg.accountId,
    preferAccountType: cfg.preferAccountType,
  });
  // Live history needs the OAuth connect first (listAccounts → getOtpUrl →
  // socket) — without it send() rejects with "WebSocket not open".
  try {
    await ws.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot connect to Deriv for live history: ${msg}`);
  }
  const blockSec = blockSeconds(cfg);
  // Full required span: `lookbackDays` of model history + 2 days of runway so
  // the first replayed blocks have history to form a band. No 5000 cap — Deriv
  // returns at most 1000 per request, so fetchCandlesHistory pages in batches.
  const bars = Math.ceil(86_400 / blockSec) * (cfg.lookbackDays + 2);
  let candles: Candle[];
  try {
    candles = await ws.fetchCandlesHistory(cfg.symbol, blockSec, bars);
  } finally {
    // Clears the ping timer + closes the socket so the process can exit cleanly
    // after printing the summary (index.tsx does not call process.exit here).
    ws.disconnect();
  }
  if (candles.length < 2) {
    throw new Error(`Deriv returned only ${candles.length} candles for ${cfg.symbol} — need more history`);
  }
  return candles;
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

export function fmtStats(s: BacktestStats, currency: string): string {
  const pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2);
  return [
    '── backtest summary ────────────────────────────────',
    `blocks     ${s.blocks}   traded ${s.traded}   skipped ${s.skipped}`,
    `win rate   ${(s.winRate * 100).toFixed(1)}%  (${s.wins}W / ${s.losses}L · legs ${s.legsWon}W/${s.legsLost}L ${(s.legWinRate * 100).toFixed(1)}%)`,
    `P&L        ${fmtSigned(s.totalPnl)} ${currency}   expectancy ${fmtSigned(s.expectancy)}/block`,
    `avg win    ${fmtSigned(s.avgWin)}   avg loss ${fmtSigned(s.avgLoss)}   profit factor ${pf}`,
    `max DD     ${fmtSigned(s.maxDrawdown)}   max streak ${s.maxConsecutiveLosses}L`,
    s.evMeasured ? `avg EV     ${Number.isFinite(s.avgEv) ? fmtSigned(s.avgEv) : '—'}/leg` : `avg EV     (no model — legacy flat-payout path)`,
    '───────────────────────────────────────────────────',
  ].join('\n');
}

export async function runBacktestCli(cfg: HiLoConfig): Promise<void> {
  const candles = await loadCandles(cfg);
  const result = await runBacktest({ candles, cfg });
  const currency = cfg.currency || 'USD';
  const { first, last } = (() => {
    const a = candles[0];
    const b = candles[candles.length - 1];
    return { first: a?.epoch ?? 0, last: b?.epoch ?? 0 };
  })();
  const span = (() => {
    if (!first || !last) return '?';
    const days = (last - first) / 86_400;
    return days >= 2 ? `${days.toFixed(1)} days` : `${((last - first) / 3600).toFixed(1)} hrs`;
  })();
  process.stdout.write(`backtest: ${candles.length} candles @ ${cfg.blockMinutes}m blocks (${span}) on ${cfg.symbol}\n`);
  process.stdout.write(`band: ${cfg.evMode ? `EV-first k∈[${cfg.kCandidates.join(',')}] minEv=${cfg.minEv}` : `fixed-K ${cfg.rangeMode} k=${cfg.rangeK}`} · mode=${cfg.mode} · stake=${cfg.stake}\n`);
  process.stdout.write(fmtStats(result.stats, currency) + '\n');
}
