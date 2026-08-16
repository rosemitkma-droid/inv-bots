#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { helpText, parseArgs } from './cli/args';
import { useStore, type LogLine } from './state/store';
import { runBacktestCli } from './cli/backtest';
import { Trader } from './trading/trader';
import { App } from './ui/App';

const VERSION = '0.1.0';

function colour(kind: LogLine['kind']): string {
  switch (kind) {
    case 'error':      return '\x1b[31m';
    case 'warn':       return '\x1b[33m';
    case 'block':      return '\x1b[36m';
    case 'trade-open': return '\x1b[32m';
    case 'trade-close':return '\x1b[35m';
    case 'sell':       return '\x1b[95m';
    case 'info':       return '\x1b[90m';
    case 'status':     return '\x1b[94m';
    default:           return '';
  }
}
const RESET = '\x1b[0m';

function fmt(line: LogLine): string {
  const t = new Date(line.at).toISOString().slice(11, 19);
  return `${colour(line.kind)}[${t}] ${line.kind.padEnd(11)} ${line.text}${RESET}`;
}

async function runPlainConsole(): Promise<void> {
  // Stream transcript lines as they're appended.
  let printedUpTo = 0;
  useStore.subscribe((st) => {
    const next = st.transcript;
    while (printedUpTo < next.length) {
      process.stdout.write(fmt(next[printedUpTo]!) + '\n');
      printedUpTo++;
    }
  });

  const cfg = useStore.getState().config!;
  const trader = new Trader(cfg);

  const onExit = () => {
    try { trader.stop(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  try {
    await trader.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\x1b[31mhilo-fast failed to start: ${msg}\x1b[0m\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(helpText() + '\n');
    return;
  }
  if (parsed.version) {
    process.stdout.write(`hilo-fast ${VERSION}\n`);
    return;
  }
  const cfg = parsed.cfg;

  if (cfg.backtest) {
    // Replay mode: no TUI, no trading. Candles come from --csv or live Deriv.
    if (!cfg.csv && !cfg.token) {
      process.stderr.write('hilo-fast: --backtest needs --csv <ohlc.csv> or --token (live history).\n\n');
      process.stderr.write(helpText() + '\n');
      process.exit(2);
    }
    try {
      await runBacktestCli(cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\x1b[31mbacktest failed: ${msg}\x1b[0m\n`);
      process.exit(1);
    }
    return;
  }

  if (!cfg.dryRun && !cfg.token) {
    process.stderr.write('hilo-fast: --token is required (or set DERIV_TOKEN). Use --dry-run to simulate.\n\n');
    process.stderr.write(helpText() + '\n');
    process.exit(2);
  }

  useStore.getState().setConfig(cfg);

  if (cfg.noUi) {
    await runPlainConsole();
    return;
  }

  const { waitUntilExit, unmount } = render(<App />);
  const onSignal = () => {
    try { unmount(); } catch { /* noop */ }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await waitUntilExit();
}

void main();
