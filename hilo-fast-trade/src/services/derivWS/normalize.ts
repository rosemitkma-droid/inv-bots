import type {
  BalancePayload,
  BuyResult,
  Candle,
  ContractUpdate,
  OhlcPayload,
  SellResult,
  TickPayload,
} from './types';

export function toNum(x: unknown): number | undefined {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  const n = typeof x === 'string' ? Number(x) : Number(x as never);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeContract(c: Record<string, unknown>): ContractUpdate {
  return {
    contract_id: Number(c.contract_id),
    is_sold: Number(c.is_sold) || 0,
    status: c.status as ContractUpdate['status'],
    profit: toNum(c.profit),
    payout: toNum(c.payout),
    buy_price: toNum(c.buy_price),
    bid_price: toNum(c.bid_price),
    entry_spot: toNum(c.entry_spot ?? c.entry_tick),
    current_spot: toNum(c.current_spot),
    exit_tick: toNum(c.exit_tick),
    is_valid_to_sell: toNum(c.is_valid_to_sell),
    date_expiry: toNum(c.date_expiry),
    shortcode: c.shortcode as string | undefined,
    barrier: c.barrier as string | undefined,
  };
}

export function normalizeBuy(b: Record<string, unknown>): BuyResult {
  return {
    contract_id: Number(b.contract_id),
    buy_price: toNum(b.buy_price) ?? 0,
    payout: toNum(b.payout) ?? 0,
    purchase_time: Number(b.purchase_time) || 0,
    start_time: Number(b.start_time) || 0,
    longcode: String(b.longcode ?? ''),
    shortcode: String(b.shortcode ?? ''),
    transaction_id: Number(b.transaction_id) || 0,
    balance_after: toNum(b.balance_after),
  };
}

export function normalizeSell(s: Record<string, unknown>): SellResult {
  return {
    contract_id: Number(s.contract_id),
    sold_for: toNum(s.sold_for) ?? 0,
    balance_after: toNum(s.balance_after),
    reference_id: toNum(s.reference_id),
    transaction_id: toNum(s.transaction_id),
  };
}

export function normalizeBalance(b: Record<string, unknown>): BalancePayload {
  return {
    balance: toNum(b.balance) ?? 0,
    currency: String(b.currency ?? ''),
    loginid: b.loginid as string | undefined,
  };
}

export function normalizeTick(t: Record<string, unknown>): TickPayload {
  return {
    epoch: Number(t.epoch) || 0,
    quote: toNum(t.quote) ?? 0,
    symbol: String(t.symbol ?? ''),
    pip_size: toNum(t.pip_size) ?? 0,
    id: t.id as string | undefined,
  };
}

export function normalizeOhlc(o: Record<string, unknown>): OhlcPayload {
  return {
    epoch: Number(o.epoch ?? o.open_time) || 0,
    open: toNum(o.open) ?? 0,
    high: toNum(o.high) ?? 0,
    low: toNum(o.low) ?? 0,
    close: toNum(o.close) ?? 0,
    symbol: String(o.symbol ?? ''),
    granularity: Number(o.granularity) || 0,
  };
}

export function normalizeCandlesResponse(candles: unknown[]): Candle[] {
  const out: Candle[] = [];
  for (const raw of candles) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const epoch = Number(c.epoch ?? c.open_time);
    const open = toNum(c.open);
    const high = toNum(c.high);
    const low = toNum(c.low);
    const close = toNum(c.close);
    if (
      !Number.isFinite(epoch) ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined
    ) {
      continue;
    }
    out.push({ epoch, open, high, low, close });
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}
