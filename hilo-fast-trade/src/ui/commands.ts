import { useStore } from '../state/store';
import { Trader } from '../trading/trader';
import type { HiLoConfig, TradeMode } from '../trading/config';
import type { RangeMode } from '../engine/rangePredictor';
import { assertBlockGranularity } from '../constants/api';

/**
 * Context passed to every command handler. App keeps a single Trader
 * reference in a ref; `getTrader()` returns the current instance (or null
 * if /stop just tore it down), and `ensureTrader()` lazily re-creates one
 * from the current store config before /start.
 */
export interface CmdCtx {
  getTrader(): Trader | null;
  ensureTrader(): Trader;
  dropTrader(): void;
  requestExit(): void;
}

export interface Command {
  name: string;
  aliases?: string[];
  argHint?: string;
  desc: string;
  handler: (args: string[], ctx: CmdCtx) => void | Promise<void>;
}

/**
 * Apply a partial config patch. Single source of truth:
 *   - if a Trader exists, let it validate + update its internal cfg and push
 *     to the store in one go (patchConfig throws on hard-field changes);
 *   - otherwise patch the store directly (used before /start).
 * One setConfig call per patch → the store notifies subscribers exactly once.
 */
function patchCfg(patch: Partial<HiLoConfig>, ctx: CmdCtx): void {
  const t = ctx.getTrader();
  if (t) {
    t.patchConfig(patch);
    return;
  }
  const cur = useStore.getState().config;
  if (!cur) throw new Error('no config loaded yet');
  useStore.getState().setConfig({ ...cur, ...patch });
}

function num(args: string[], label: string): number {
  const raw = args[0];
  if (raw === undefined) throw new Error(`usage: /${label} <number>`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`/${label}: '${raw}' is not a number`);
  return n;
}

function optNum(args: string[]): number | undefined {
  if (args[0] === undefined || args[0].toLowerCase() === 'off' || args[0] === '-') return undefined;
  const n = Number(args[0]);
  if (!Number.isFinite(n)) throw new Error(`'${args[0]}' is not a number (use a value or 'off')`);
  return n;
}

export const COMMANDS: Command[] = [
  {
    name: 'start',
    desc: 'start the bot',
    handler: async (_, ctx) => {
      const st = useStore.getState();
      if (st.status === 'running' || st.status === 'connecting') {
        st.append('warn', '/start: already running');
        return;
      }
      // A prior session TP/SL halt may have set `halted`; /start is the
      // explicit "trade again" intent, so clear it.
      st.unhalt();
      const trader = ctx.ensureTrader();
      try {
        await trader.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useStore.getState().setStatus('error');
        useStore.getState().append('error', `start failed: ${msg}`);
        ctx.dropTrader();
      }
    },
  },
  {
    name: 'stop',
    aliases: ['halt'],
    desc: 'stop the bot and drop any open subscriptions',
    handler: (_, ctx) => {
      const t = ctx.getTrader();
      if (!t) {
        useStore.getState().append('warn', '/stop: not running');
        return;
      }
      t.stop();
      ctx.dropTrader();
      useStore.getState().append('system', 'stopped');
    },
  },
  {
    name: 'block-tp',
    aliases: ['tp', 'btp', 'blocktp'],
    argHint: '<usd>',
    desc: 'close pair early when its summed live P/L >= N (per block)',
    handler: (args, ctx) => {
      const n = num(args, 'block-tp');
      if (n <= 0) throw new Error('/block-tp: value must be > 0');
      patchCfg({ blockTp: n }, ctx);
      useStore.getState().append('info', `block TP set to ${n.toFixed(2)}`);
    },
  },
  {
    name: 'block-sl',
    aliases: ['bsl', 'blocksl'],
    argHint: '<usd|off>',
    desc: 'close pair when combined live P/L <= -N (per block, or off)',
    handler: (args, ctx) => {
      const v = optNum(args);
      if (v !== undefined && v < 0) throw new Error('/block-sl: value must be >= 0');
      patchCfg({ blockSl: v ?? 0 }, ctx);
      useStore.getState().append('info', `block SL ${v === undefined ? 'disabled' : `set to -${v.toFixed(2)}`}`);
    },
  },
  {
    name: 'block-trail',
    aliases: ['trail', 'btrail', 'blocktrail'],
    argHint: '<usd|off>',
    desc: 'close pair when P/L retraces this far below its intrabar peak (or off)',
    handler: (args, ctx) => {
      const v = optNum(args);
      if (v !== undefined && v < 0) throw new Error('/block-trail: value must be >= 0');
      patchCfg({ blockTrail: v ?? 0 }, ctx);
      useStore.getState().append('info', `block trail ${v === undefined ? 'disabled' : `set to ${v.toFixed(2)} retrace`}`);
    },
  },
  {
    name: 'stagger',
    desc: 'size each leg by its edge: stake × clamp(1 + 2·(trueP−impliedP))',
    handler: (args, ctx) => {
      const raw = args[0]?.toLowerCase();
      if (raw !== undefined && raw !== 'on' && raw !== '1' && raw !== 'off' && raw !== '0') {
        throw new Error('/stagger: use on or off (no arg toggles)');
      }
      const on = raw === undefined ? !useStore.getState().config?.evStagger : raw === 'on' || raw === '1';
      patchCfg({ evStagger: on }, ctx);
      useStore.getState().append('info', `ev-stagger ${on ? 'ON' : 'off'} — per-leg stake follows trueP−impliedP`);
    },
  },
  {
    name: 'session-tp',
    aliases: ['stp', 'sessiontp'],
    argHint: '<usd|off>',
    desc: 'halt trading when session P/L >= N (or off)',
    handler: (args, ctx) => {
      const v = optNum(args);
      patchCfg({ sessionTp: v }, ctx);
      useStore.getState().append('info', `session TP ${v === undefined ? 'disabled' : `set to ${v.toFixed(2)}`}`);
    },
  },
  {
    name: 'session-sl',
    aliases: ['ssl', 'sessionsl'],
    argHint: '<usd|off>',
    desc: 'halt trading when session P/L <= -N (or off)',
    handler: (args, ctx) => {
      const v = optNum(args);
      patchCfg({ sessionSl: v }, ctx);
      useStore.getState().append('info', `session SL ${v === undefined ? 'disabled' : `set to -${v.toFixed(2)}`}`);
    },
  },
  {
    name: 'stake',
    argHint: '<usd>',
    desc: 'per-leg stake (applies to next block)',
    handler: (args, ctx) => {
      const n = num(args, 'stake');
      if (n <= 0) throw new Error('/stake: value must be > 0');
      patchCfg({ stake: n }, ctx);
      useStore.getState().append('info', `stake set to ${n.toFixed(2)} (next block)`);
    },
  },
  {
    name: 'symbol',
    argHint: '<sym>',
    desc: 'change symbol (requires restart — runs /stop first)',
    handler: (args, ctx) => {
      const sym = args[0];
      if (!sym) throw new Error('usage: /symbol <sym>');
      const t = ctx.getTrader();
      if (t) { t.stop(); ctx.dropTrader(); useStore.getState().append('system', 'stopped for symbol change'); }
      const cur = useStore.getState().config!;
      useStore.getState().setConfig({ ...cur, symbol: sym });
      useStore.getState().append('info', `symbol set to ${sym} — /start to resume`);
    },
  },
  {
    name: 'block',
    argHint: '<minutes>',
    desc: 'change block size (requires restart)',
    handler: (args, ctx) => {
      const n = num(args, 'block');
      if (n <= 0 || !Number.isInteger(n)) throw new Error('/block: positive integer minutes');
      assertBlockGranularity(n);
      const t = ctx.getTrader();
      if (t) { t.stop(); ctx.dropTrader(); useStore.getState().append('system', 'stopped for block-size change'); }
      const cur = useStore.getState().config!;
      useStore.getState().setConfig({ ...cur, blockMinutes: n });
      useStore.getState().append('info', `block size set to ${n} min — /start to resume`);
    },
  },
  {
    name: 'mode',
    argHint: '[higher-lower|no-touch]',
    desc: 'trade primitive per leg — no arg opens a picker (auto-stops; /start to resume)',
    handler: (args, ctx) => {
      if (args.length === 0) {
        openModePicker(ctx);
        return;
      }
      const raw = args[0]!.toLowerCase();
      const map: Record<string, TradeMode> = {
        hl: 'higher-lower', 'higher-lower': 'higher-lower', higherlower: 'higher-lower',
        nt: 'no-touch', 'no-touch': 'no-touch', notouch: 'no-touch',
      };
      const m = map[raw];
      if (!m) throw new Error('/mode: one of higher-lower, no-touch');
      applyTradeMode(m, ctx);
    },
  },
  {
    name: 'range-mode',
    aliases: ['rangemode', 'rm'],
    argHint: '[hybrid|historical|atr]',
    desc: 'prediction model — no arg opens a picker (auto-stops; /start to resume)',
    handler: (args, ctx) => {
      if (args.length === 0) {
        openRangeModePicker(ctx);
        return;
      }
      const raw = args[0]!.toLowerCase();
      const map: Record<string, RangeMode> = {
        h: 'hybrid', hybrid: 'hybrid',
        hist: 'historical', historical: 'historical',
        atr: 'atr',
      };
      const m = map[raw];
      if (!m) throw new Error('/range-mode: one of hybrid, historical, atr');
      applyRangeMode(m, ctx);
    },
  },
  {
    name: 'status',
    aliases: ['st'],
    desc: 'print current session + config summary',
    handler: () => {
      const s = useStore.getState();
      const c = s.config;
      const sess = s.session;
      if (!c) { s.append('info', 'no config loaded'); return; }
      s.append('status', `symbol=${c.symbol} mode=${c.mode} block=${c.blockMinutes}m stake=${c.stake} blockTP=${c.blockTp} blockSL=${c.blockSl ? '-' + c.blockSl : 'off'} trail=${c.blockTrail ? c.blockTrail : 'off'} sessionTP=${c.sessionTp ?? 'off'} sessionSL=${c.sessionSl ?? 'off'}${c.evMode ? ` evMode(minEv=${c.minEv})` : ''}${c.evStagger ? ' stagger' : ''}`);
      s.append('status', `session: ${sess.trades} trades  W/L ${sess.wins}/${sess.losses}  net ${sess.totalProfit >= 0 ? '+' : ''}${sess.totalProfit.toFixed(2)}`);
    },
  },
  {
    name: 'cfg',
    desc: 'dump full config',
    handler: () => {
      const c = useStore.getState().config;
      if (!c) { useStore.getState().append('info', 'no config'); return; }
      const red = { ...c, token: c.token ? `••••${c.token.slice(-4)}` : '' };
      useStore.getState().append('status', JSON.stringify(red));
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    desc: 'clear transcript',
    handler: () => useStore.getState().clearTranscript(),
  },
  {
    name: 'reset',
    desc: 'clear the halted state and reset session stats',
    handler: () => {
      const st = useStore.getState();
      st.unhalt();
      st.resetSession();
      st.append('system', 'session reset — halted state cleared');
    },
  },
  {
    name: 'help',
    aliases: ['?'],
    desc: 'list commands',
    handler: () => {
      const s = useStore.getState();
      s.append('info', 'commands:');
      for (const c of COMMANDS) {
        const al = c.aliases?.length ? ` (${c.aliases.map((a) => `/${a}`).join(', ')})` : '';
        const ah = c.argHint ? ` ${c.argHint}` : '';
        s.append('info', `  /${c.name}${ah}${al}  —  ${c.desc}`);
      }
    },
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    desc: 'exit the CLI',
    handler: (_, ctx) => ctx.requestExit(),
  },
];

function applyTradeMode(m: TradeMode, ctx: CmdCtx): void {
  const t = ctx.getTrader();
  if (t) {
    t.stop();
    ctx.dropTrader();
    useStore.getState().append('system', 'stopped for trade-mode change');
  }
  const cur = useStore.getState().config!;
  useStore.getState().setConfig({ ...cur, mode: m });
  useStore.getState().append('info', `trade mode set to ${m} — /start to resume`);
}

function applyRangeMode(m: RangeMode, ctx: CmdCtx): void {
  const t = ctx.getTrader();
  if (t) {
    t.stop();
    ctx.dropTrader();
    useStore.getState().append('system', 'stopped for range-mode change');
  }
  const cur = useStore.getState().config!;
  useStore.getState().setConfig({ ...cur, rangeMode: m });
  useStore.getState().append('info', `range mode set to ${m} — /start to resume`);
}

function openModePicker(ctx: CmdCtx): void {
  const cur = useStore.getState().config?.mode;
  const pick = (m: TradeMode) => {
    useStore.getState().popMenu();
    applyTradeMode(m, ctx);
  };
  useStore.getState().pushMenu({
    title: 'Trade mode — pick primitive',
    items: [
      {
        label: 'HIGHER/LOWER',
        hint: 'stay-in-range · win if EXIT spot lands inside [predL, predH]',
        checked: cur === 'higher-lower',
        onSelect: () => pick('higher-lower'),
      },
      {
        label: 'NO TOUCH',
        hint: 'stay-in-range · win if spot NEVER touches either barrier (stricter)',
        checked: cur === 'no-touch',
        onSelect: () => pick('no-touch'),
      },
    ],
  });
}

function openRangeModePicker(ctx: CmdCtx): void {
  const cur = useStore.getState().config?.rangeMode;
  const pick = (m: RangeMode) => {
    useStore.getState().popMenu();
    applyRangeMode(m, ctx);
  };
  useStore.getState().pushMenu({
    title: 'Range prediction — pick model',
    items: [
      {
        label: 'hybrid',
        hint: 'historical same-TOD, ATR fallback',
        checked: cur === 'hybrid',
        onSelect: () => pick('hybrid'),
      },
      {
        label: 'historical',
        hint: 'mean excursion of last N same-TOD blocks',
        checked: cur === 'historical',
        onSelect: () => pick('historical'),
      },
      {
        label: 'atr',
        hint: 'ATR √(bars) · K anchored at block open',
        checked: cur === 'atr',
        onSelect: () => pick('atr'),
      },
    ],
  });
}

export function findCommand(name: string): Command | undefined {
  const lc = name.toLowerCase();
  return COMMANDS.find((c) => c.name === lc || c.aliases?.includes(lc));
}

export function matchCommands(prefix: string): Command[] {
  const lc = prefix.toLowerCase();
  if (!lc) return COMMANDS.slice();
  return COMMANDS.filter(
    (c) => c.name.startsWith(lc) || c.aliases?.some((a) => a.startsWith(lc)),
  );
}

export async function dispatchCommand(input: string, ctx: CmdCtx): Promise<void> {
  const raw = input.trim();
  if (!raw) return;
  const payload = raw.startsWith('/') ? raw.slice(1) : raw;
  const parts = payload.split(/\s+/);
  const name = parts[0] ?? '';
  const args = parts.slice(1);
  useStore.getState().append('info', `> /${name}${args.length ? ' ' + args.join(' ') : ''}`);
  const cmd = findCommand(name);
  if (!cmd) {
    useStore.getState().append('error', `unknown command: /${name} — try /help`);
    return;
  }
  try {
    await cmd.handler(args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useStore.getState().append('error', `/${name}: ${msg}`);
  }
}
