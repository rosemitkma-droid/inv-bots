import {
  PING_INTERVAL_MS,
  SESSION_ROLLOVER_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MAX_ATTEMPTS,
} from '../../constants/api';
import {
  listAccounts,
  getOtpUrl,
  pickDefaultAccount,
  type DerivAccount,
} from '../derivRest';
import {
  toNum,
  normalizeBalance,
  normalizeBuy,
  normalizeCandlesResponse,
  normalizeContract,
  normalizeOhlc,
  normalizeSell,
  normalizeTick,
} from './normalize';
import type {
  BalancePayload,
  BuyResult,
  Candle,
  ContractConstraints,
  ContractsForResult,
  ContractUpdate,
  DerivWSOptions,
  OhlcPayload,
  PortfolioContract,
  ProposalParams,
  ProposalResult,
  SellResult,
  TickPayload,
} from './types';

type Json = Record<string, unknown>;

interface PendingRequest {
  resolve: (data: Json) => void;
  reject: (err: Error) => void;
}

type EventMap = {
  tick: (t: TickPayload) => void;
  ohlc: (o: OhlcPayload) => void;
  balance: (b: BalancePayload) => void;
  contract: (c: ContractUpdate) => void;
  status: (s: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error') => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
  // Fired after rollover/reconnect — listeners must re-issue their subscriptions
  // since the new socket has none of the old ones.
  reconnect: () => void;
};

export class DerivWS {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, PendingRequest>();
  private listeners: { [K in keyof EventMap]: Set<EventMap[K]> } = {
    tick: new Set(),
    ohlc: new Set(),
    balance: new Set(),
    contract: new Set(),
    status: new Set(),
    error: new Set(),
    info: new Set(),
    reconnect: new Set(),
  };
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private selectedAccount: DerivAccount | null = null;

  constructor(private opts: DerivWSOptions) {}

  getAccount(): DerivAccount | null {
    return this.selectedAccount;
  }

  on<K extends keyof EventMap>(event: K, handler: EventMap[K]): () => void {
    this.listeners[event].add(handler as never);
    return () => this.listeners[event].delete(handler as never);
  }

  private emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    for (const h of this.listeners[event]) {
      (h as (...a: unknown[]) => void)(...args);
    }
  }

  async connect(): Promise<DerivAccount> {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.emit('status', 'connecting');

    const accounts = await listAccounts(this.opts.appId, this.opts.token);
    if (accounts.length === 0) {
      throw new Error('no accounts returned for this token');
    }

    let account: DerivAccount | null;
    if (this.opts.accountId) {
      account = accounts.find((a) => a.account_id === this.opts.accountId) ?? null;
      if (!account) {
        throw new Error(
          `account ${this.opts.accountId} not found — available: ${accounts.map((a) => a.account_id).join(', ')}`,
        );
      }
    } else {
      account = pickDefaultAccount(accounts, this.opts.preferAccountType);
      if (!account) throw new Error('no active account found');
    }

    this.selectedAccount = account;
    const wsUrl = await getOtpUrl(this.opts.appId, this.opts.token, account.account_id);
    this.ws = await this.openSocket(wsUrl);
    this.startPing();
    this.scheduleRollover();
    this.emit('status', 'open');
    return account;
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;

      ws.onopen = () => {
        if (!settled) {
          settled = true;
          resolve(ws);
        }
      };
      ws.onmessage = (ev) => {
        try {
          this.handleMessage(JSON.parse(ev.data as string));
        } catch {
          /* ignore */
        }
      };
      ws.onerror = (ev) => {
        const detail =
          (ev as unknown as { message?: string }).message ??
          (ev as unknown as { error?: { message?: string } }).error?.message ??
          '';
        if (!settled) {
          settled = true;
          reject(new Error(`ws error during open${detail ? ': ' + detail : ''}`));
          return;
        }
        if (detail) this.emit('error', `ws error: ${detail}`);
      };
      ws.onclose = (ev) => {
        const code = (ev as CloseEvent).code ?? null;
        const reason = (ev as CloseEvent).reason ?? '';
        if (!settled) {
          settled = true;
          const detail = [
            code !== null ? `code=${code}` : null,
            reason ? `reason="${reason}"` : null,
          ]
            .filter(Boolean)
            .join(' ');
          reject(new Error(`WebSocket connection failed${detail ? ' (' + detail + ')' : ''}`));
          return;
        }
        this.handleClose(ws, code, reason);
      };
    });
  }

  private handleClose(ws: WebSocket, code: number | null, reason: string): void {
    if (ws !== this.ws) return;
    this.stopPing();
    this.clearRolloverTimer();
    if (this.intentionalClose) {
      this.emit('status', 'closed');
      return;
    }
    const detail = code !== null ? `code=${code}${reason ? ' ' + reason : ''}` : 'unexpected close';
    this.emit('info', `connection lost (${detail}) — reconnecting…`);
    this.scheduleReactiveReconnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    this.clearRolloverTimer();
    this.clearReconnectTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    for (const p of this.pending.values()) {
      p.reject(new Error('WebSocket closed'));
    }
    this.pending.clear();
  }

  private scheduleRollover(): void {
    this.clearRolloverTimer();
    this.rolloverTimer = setTimeout(() => {
      void this.performRollover();
    }, SESSION_ROLLOVER_MS);
  }

  private clearRolloverTimer(): void {
    if (this.rolloverTimer) {
      clearTimeout(this.rolloverTimer);
      this.rolloverTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async performRollover(): Promise<void> {
    if (this.intentionalClose || this.reconnecting) return;
    if (!this.selectedAccount) return;
    this.reconnecting = true;
    this.emit('status', 'reconnecting');
    this.emit('info', 'session rollover — refreshing OTP');
    const oldWs = this.ws;
    try {
      const wsUrl = await getOtpUrl(
        this.opts.appId,
        this.opts.token,
        this.selectedAccount.account_id,
      );
      if (this.intentionalClose) return;
      const newWs = await this.openSocket(wsUrl);
      if (this.intentionalClose) {
        try { newWs.close(); } catch { /* noop */ }
        return;
      }
      this.ws = newWs;
      this.stopPing();
      this.startPing();
      this.reconnectAttempts = 0;
      this.rejectPending('session rolled over');
      if (oldWs) {
        try { oldWs.close(); } catch { /* noop */ }
      }
      this.scheduleRollover();
      this.emit('status', 'open');
      this.emit('info', 'session rollover complete');
      this.emit('reconnect');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', `rollover failed: ${msg}`);
      if (!oldWs || oldWs.readyState !== 1) {
        this.scheduleReactiveReconnect();
      } else {
        this.clearRolloverTimer();
        this.rolloverTimer = setTimeout(() => {
          void this.performRollover();
        }, RECONNECT_MAX_MS);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private scheduleReactiveReconnect(): void {
    if (this.intentionalClose) return;
    this.clearReconnectTimer();
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.emit('error', `reconnect gave up after ${RECONNECT_MAX_ATTEMPTS} attempts`);
      this.emit('status', 'closed');
      return;
    }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    this.emit('status', 'reconnecting');
    this.emit('info', `reconnect attempt ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay / 100) / 10}s`);
    this.reconnectTimer = setTimeout(() => {
      void this.attemptReactiveReconnect();
    }, delay);
  }

  private async attemptReactiveReconnect(): Promise<void> {
    if (this.intentionalClose || this.reconnecting) return;
    if (!this.selectedAccount) {
      this.emit('error', 'cannot reconnect: no selected account');
      this.emit('status', 'closed');
      return;
    }
    this.reconnecting = true;
    try {
      const wsUrl = await getOtpUrl(
        this.opts.appId,
        this.opts.token,
        this.selectedAccount.account_id,
      );
      if (this.intentionalClose) return;
      const newWs = await this.openSocket(wsUrl);
      if (this.intentionalClose) {
        try { newWs.close(); } catch { /* noop */ }
        return;
      }
      this.ws = newWs;
      this.startPing();
      this.reconnectAttempts = 0;
      this.rejectPending('reconnected');
      this.scheduleRollover();
      this.emit('status', 'open');
      this.emit('info', 'reconnected');
      this.emit('reconnect');
    } catch (err) {
      if (this.intentionalClose) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', `reconnect failed: ${msg}`);
      this.scheduleReactiveReconnect();
    } finally {
      this.reconnecting = false;
    }
  }

  private rejectPending(reason: string): void {
    for (const p of this.pending.values()) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.raw({ ping: 1 });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private raw(payload: Json): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  send(payload: Json): Promise<Json> {
    const req_id = ++this.reqId;
    return new Promise<Json>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('WebSocket not open'));
        return;
      }
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  private handleMessage(data: Json): void {
    const reqId = data.req_id as number | undefined;
    const msgType = data.msg_type as string | undefined;
    const err = data.error as { code?: string; message?: string } | undefined;

    if (reqId && this.pending.has(reqId)) {
      const pend = this.pending.get(reqId)!;
      if (err) {
        pend.reject(new Error(`[${err.code ?? 'Error'}] ${err.message ?? 'Unknown error'}`));
        this.pending.delete(reqId);
        return;
      }
      pend.resolve(data);
      this.pending.delete(reqId);
    }

    if (err && !reqId) {
      this.emit('error', `${err.code ?? 'Error'}: ${err.message ?? 'Unknown'}`);
    }

    switch (msgType) {
      case 'tick': {
        const raw = data.tick as Record<string, unknown> | undefined;
        if (raw) this.emit('tick', normalizeTick(raw));
        break;
      }
      case 'ohlc': {
        const raw = data.ohlc as Record<string, unknown> | undefined;
        if (raw) this.emit('ohlc', normalizeOhlc(raw));
        break;
      }
      case 'balance': {
        const raw = data.balance as Record<string, unknown> | undefined;
        if (raw) this.emit('balance', normalizeBalance(raw));
        break;
      }
      case 'proposal_open_contract': {
        const raw = data.proposal_open_contract as Record<string, unknown> | undefined;
        if (raw) this.emit('contract', normalizeContract(raw));
        break;
      }
      default:
        break;
    }
  }

  // ─── High-level helpers ────────────────────────────────────────────

  async getBalance(): Promise<BalancePayload> {
    const res = await this.send({ balance: 1 });
    return normalizeBalance((res.balance ?? {}) as Record<string, unknown>);
  }

  async subscribeBalance(): Promise<void> {
    await this.send({ balance: 1, subscribe: 1 });
  }

  async subscribeTicks(symbol: string): Promise<void> {
    await this.send({ ticks: symbol, subscribe: 1 });
  }

  /**
   * Fetch historical candles and optionally subscribe to live updates. Deriv
   * permitted granularities: 60,120,180,300,600,900,1800,3600,7200,14400,28800,86400.
   *
   * Response arrives as either { candles: [...] } for history-only, or with a
   * separate `ohlc` message stream when subscribe=1.
   */
  async getCandles(
    symbol: string,
    granularity: number,
    count: number,
    subscribe = false,
  ): Promise<Candle[]> {
    const res = await this.send({
      ticks_history: symbol,
      end: 'latest',
      count,
      style: 'candles',
      granularity,
      ...(subscribe ? { subscribe: 1 } : {}),
    });
    const arr = (res.candles as unknown[] | undefined) ?? [];
    return normalizeCandlesResponse(arr);
  }

  /**
   * Deriv caps a single `style=candles` history request at 1000 candles, so a
   * multi-day backtest span has to be paged. This pages BACKWARD in batches of
   * 1000, anchoring each page on the previous page's OLDEST candle epoch (an
   * actual timestamp, not an offset), so pages tile the timeline without gaps.
   * Returns ascending by epoch with boundary duplicates removed.
   */
  async fetchCandlesHistory(
    symbol: string,
    granularity: number,
    count: number,
  ): Promise<Candle[]> {
    const out: Candle[] = [];
    let end: number | 'latest' = 'latest';
    let prevEarliest = Infinity;
    while (out.length < count) {
      const want = Math.min(1000, count - out.length);
      const res = await this.send({
        ticks_history: symbol,
        end,
        count: want,
        style: 'candles',
        granularity,
      });
      const page = normalizeCandlesResponse((res.candles as unknown[] | undefined) ?? []);
      if (page.length === 0) break; // no more history
      const earliest = page[0]!.epoch;
      // Guard against a server that ignores `end` (would loop on the same page).
      if (earliest >= prevEarliest) break;
      prevEarliest = earliest;
      out.push(...page);
      if (page.length < want) break; // server returned fewer than asked → exhausted
      end = earliest; // next page: everything older than this candle
    }
    // Adjacent pages may both contain the boundary candle (server may treat `end`
    // as inclusive) — collapse to one per epoch and sort the full timeline.
    const byEpoch = new Map<number, Candle>();
    for (const c of out) byEpoch.set(c.epoch, c);
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  }

  async getTicksHistory(symbol: string, count: number): Promise<number[]> {
    const res = await this.send({
      ticks_history: symbol,
      end: 'latest',
      count,
      style: 'ticks',
    });
    const history = res.history as { prices?: unknown[] } | undefined;
    const prices = history?.prices ?? [];
    return prices.map((p) => toNum(p) ?? NaN).filter((n) => Number.isFinite(n));
  }

  async getProposal(params: ProposalParams): Promise<ProposalResult> {
    const res = await this.send({
      proposal: 1,
      amount: params.amount,
      basis: params.basis ?? 'stake',
      contract_type: params.contract_type,
      currency: params.currency,
      duration: params.duration,
      duration_unit: params.duration_unit,
      underlying_symbol: params.symbol,
      barrier: params.barrier,
    });
    const p = (res.proposal ?? {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : '';
    if (!id) throw new Error('proposal: missing id in response');
    const askPrice = toNum(p.ask_price) ?? 0;
    const payout = toNum(p.payout) ?? 0;
    return {
      id,
      ask_price: askPrice,
      payout,
      spot: toNum(p.spot) ?? 0,
      // Market-implied win probability. Guard the degenerate payout=0 case.
      impliedP: payout > 0 ? askPrice / payout : undefined,
    };
  }

  /**
   * Two-step proposal→buy. Deriv's `buy.price` is the MAXIMUM we're willing
   * to pay; setting it to the proposed ask_price exactly means any spot
   * movement between proposal response and buy dispatch returns PriceMoved.
   * We pad by `slippagePct` (default 10%) so small intrabar moves don't
   * reject the order, while large moves still do.
   */
  async buyContract(
    params: ProposalParams,
    slippagePct: number = 0.1,
  ): Promise<BuyResult> {
    const proposal = await this.getProposal(params);
    const maxPrice = +(proposal.ask_price * (1 + Math.max(0, slippagePct))).toFixed(2);
    const res = await this.send({
      buy: proposal.id,
      price: maxPrice,
      subscribe: 1,
    });
    const buy = normalizeBuy((res.buy ?? {}) as Record<string, unknown>);
    return { ...buy, impliedP: proposal.impliedP };
  }

  /**
   * Sell an open contract at the current market bid. `price: 0` means accept
   * any bid — use a positive value as a minimum-acceptable guard if needed.
   * Callers must first verify `is_valid_to_sell === 1` on the latest
   * proposal_open_contract update; Deriv rejects sells on contracts that
   * aren't currently saleable.
   */
  async sellContract(contractId: number, price = 0): Promise<SellResult> {
    const res = await this.send({ sell: contractId, price });
    return normalizeSell((res.sell ?? {}) as Record<string, unknown>);
  }

  async subscribeOpenContract(contractId: number): Promise<void> {
    await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  async forgetAll(streams: Array<'ticks' | 'ohlc' | 'balance' | 'proposal_open_contract'>): Promise<void> {
    await this.send({ forget_all: streams });
  }

  async getPortfolio(): Promise<PortfolioContract[]> {
    const res = await this.send({ portfolio: 1 });
    const portfolio = res.portfolio as { contracts?: unknown[] } | undefined;
    const list = portfolio?.contracts;
    if (!Array.isArray(list)) return [];
    const out: PortfolioContract[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const id = Number(c.contract_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        contract_id: id,
        contract_type: String(c.contract_type ?? ''),
        buy_price: toNum(c.buy_price) ?? 0,
        payout: toNum(c.payout) ?? 0,
        symbol:
          typeof c.symbol === 'string'
            ? c.symbol
            : typeof c.underlying_symbol === 'string'
              ? (c.underlying_symbol as string)
              : undefined,
        longcode: typeof c.longcode === 'string' ? (c.longcode as string) : undefined,
        shortcode: typeof c.shortcode === 'string' ? (c.shortcode as string) : undefined,
        purchase_time: toNum(c.purchase_time),
        expiry_time: toNum(c.expiry_time),
      });
    }
    return out;
  }

  /**
   * Query which contract types are available for a given symbol, plus each
   * type's min/max duration and barrier category. Deriv may list the same
   * contract_type multiple times with different barrier profiles — we widen
   * the min→max window across all entries so a caller gets the outer bounds.
   */
  async getContractsFor(symbol: string): Promise<ContractsForResult> {
    const res = await this.send({ contracts_for: symbol });
    const cf = (res.contracts_for ?? {}) as Record<string, unknown>;
    const available = (cf.available as unknown[] | undefined) ?? [];
    const types = new Set<string>();
    const constraints: Record<string, ContractConstraints> = {};
    for (const raw of available) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const t = r.contract_type;
      if (typeof t !== 'string') continue;
      types.add(t);

      const minSec = typeof r.min_contract_duration === 'string'
        ? parseDurationStr(r.min_contract_duration) : undefined;
      const maxSec = typeof r.max_contract_duration === 'string'
        ? parseDurationStr(r.max_contract_duration) : undefined;
      const bc = typeof r.barrier_category === 'string' ? r.barrier_category : undefined;

      const prev = constraints[t] ?? {};
      constraints[t] = {
        minDurationSec:
          minSec !== undefined
            ? prev.minDurationSec === undefined
              ? minSec
              : Math.min(prev.minDurationSec, minSec)
            : prev.minDurationSec,
        maxDurationSec:
          maxSec !== undefined
            ? prev.maxDurationSec === undefined
              ? maxSec
              : Math.max(prev.maxDurationSec, maxSec)
            : prev.maxDurationSec,
        barrierCategory: bc ?? prev.barrierCategory,
      };
    }
    return {
      symbol,
      contract_types: types,
      pip_size: toNum(cf.pip_size) ?? 0,
      constraints,
    };
  }
}

/**
 * Parse Deriv's duration strings like "15s", "5t", "1m", "1d", "365d" into
 * seconds. Returns undefined on an unparseable input. Ticks are treated as
 * ~1s each — fine for 1HZ synthetics where ticks arrive once per second,
 * approximate for R_* where ticks arrive every ~2s.
 */
function parseDurationStr(s: string): number | undefined {
  const m = /^(\d+)\s*(t|s|m|h|d)$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (m[2]) {
    case 't': return n;
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default:  return undefined;
  }
}
