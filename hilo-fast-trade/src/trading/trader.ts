import { BlockClock, type BlockWindow } from '../engine/blockClock';
import {
  selectBand,
  winRateModelFromMeans,
  type WinRateModel,
} from '../engine/bandSelector';
import { simulateQuote } from '../engine/dryRunPricing';
import { predictRange, type RangePrediction } from '../engine/rangePredictor';
import { regimeFromConfig } from '../engine/regime';
import {
  appendLedgerRow,
  ledgerDayPnl,
  loadLedger,
  utcDayKey,
  type LedgerRow,
} from '../engine/ledger';
import { DerivWS } from '../services/derivWS';
import { createTelegramNotifier } from '../services/telegram';
import type { Candle, ContractUpdate, OhlcPayload, TickPayload } from '../services/derivWS/types';
import { DEFAULT_APP_ID } from '../constants/api';
import { useStore } from '../state/store';
import { blockSeconds, type HiLoConfig } from './config';
import { contractTypeFor, PairTrader } from './pairTrader';

const HISTORY_BAR_TARGET_PER_DAY = (blockSec: number) => Math.ceil(86_400 / blockSec);

export class Trader {
  private ws: DerivWS;
  private clock: BlockClock;
  private pair: PairTrader;
  private candles: Candle[] = [];
  private openContractIds = new Set<number>();
  private stopped = false;
  private offFns: Array<() => void> = [];
  /** Symbol pip precision, used to format EV-selector barrier quotes. */
  private pipDigits = 2;
  /** True once live tick+candle subscriptions are confirmed after (re)connect. */
  private subscribed = false;
  /** Ledger seeding (from file) only happens once per Trader instance. */
  private ledgerSeeded = false;
  /** Dry-run synthetic tick simulator + current-block intrabar tracking. */
  private dryRunTicks: ReturnType<typeof setInterval> | null = null;
  private intraHigh = -Infinity;
  private intraLow = Infinity;
  /** Hourly trade-summary timer. */
  private hourlyTimer: ReturnType<typeof setInterval> | null = null;
  /** Session trade count at the start of the current hour (for hourly delta). */
  private hourlyTradesBase = 0;
  /** Telegram notifier (best-effort). */
  private telegram: ReturnType<typeof createTelegramNotifier>;

  constructor(private cfg: HiLoConfig) {
    this.telegram = createTelegramNotifier(cfg.telegramToken, cfg.telegramChatId);
    this.ws = new DerivWS({
      appId: cfg.appId || DEFAULT_APP_ID,
      token: cfg.token,
      accountId: cfg.accountId,
      preferAccountType: cfg.preferAccountType,
    });
    this.clock = new BlockClock(blockSeconds(cfg));
    this.pair = new PairTrader({
      ws: this.ws,
      cfg: () => this.cfg,
      registerContractId: (id) => this.openContractIds.add(id),
      unregisterContractId: (id) => this.openContractIds.delete(id),
      notify: this.telegram.enabled ? this.telegram : undefined,
    });
  }

  async start(): Promise<void> {
    const st = useStore.getState();
    st.setStatus('connecting');
    st.append('system', `HiLo-Fast starting — symbol=${this.cfg.symbol} block=${this.cfg.blockMinutes}m stake=${this.cfg.stake} blockTP=${this.cfg.blockTp}${this.cfg.dryRun ? ' [DRY-RUN]' : ''}`);
    this.seedDayFromLedger();
    // If the ledger says today is already blown (or the streak is already done),
    // halt BEFORE the first block — don't trade a cap that was hit while we were off.
    this.evaluateSessionGuards();

    this.wireWsEvents();

    if (this.cfg.dryRun) {
      st.append('info', 'dry-run — skipping Deriv auth, using synthetic candles');
      await this.bootDryRun();
      this.startDryRunTicks();
      this.subscribed = true;
    } else {
      const account = await this.ws.connect();
      st.setAccount({
        loginid: account.account_id,
        type: account.account_type,
        balance: account.balance,
        currency: account.currency,
      });
      // Currency: use the account's currency if the caller didn't override.
      if (!this.cfg.currency) this.cfg.currency = account.currency || 'USD';
      st.append('system', `connected — ${account.account_type} ${account.account_id} ${account.currency} ${account.balance.toFixed(2)}`);

      if (!this.cfg.skipContractCheck) {
        await this.verifySymbolSupports();
      }
      await this.ws.subscribeTicks(this.cfg.symbol);
      await this.loadHistoricalCandles();
      await this.subscribeLiveCandles();
      // Keep the balance card live — without this it stays frozen at connect.
      try {
        await this.ws.subscribeBalance();
      } catch {
        /* best-effort */
      }
      this.subscribed = true;
    }

    // Block clock — fires 'block-end' then 'block-start' on every boundary.
    this.offFns.push(this.clock.on('block-end', (w) => this.onBlockEnd(w)));
    this.offFns.push(this.clock.on('block-start', (w) => this.onBlockStart(w)));
    this.clock.start();

    // Hourly trade-summary timer (fires at the top of every UTC hour).
    this.hourlyTradesBase = useStore.getState().session.trades;
    const msToNextHour = (60 - new Date().getUTCMinutes()) * 60_000;
    setTimeout(() => {
      this.sendHourlySummary();
      this.hourlyTimer = setInterval(() => this.sendHourlySummary(), 3_600_000);
    }, msToNextHour);

    // Strategy is block-anchored: the prediction is locked at the first bar
    // of a block and the contracts are sized to expire on the block end.
    // Mid-block entries mean the prediction is already stale (spot has
    // drifted since blockOpen) and the duration is a weird partial. So we
    // deliberately SKIP the in-progress block and wait for the next fresh
    // boundary. Applies to both HIGHER/LOWER and NOTOUCH modes.
    const now = this.clock.currentWindow();
    const waitSec = Math.max(0, Math.ceil(now.end - Date.now() / 1000));
    const nextHM = new Date(now.end * 1000).toISOString().slice(11, 16) + 'Z';
    st.append('info', `waiting for next block at ${nextHM} (~${waitSec}s)`);

    // A boot-time circuit-breaker (day already blown / streak already done) may
    // have halted us — don't overwrite that with 'running'.
    if (!useStore.getState().halted) st.setStatus('running');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clock.stop();
    if (this.dryRunTicks) {
      clearInterval(this.dryRunTicks);
      this.dryRunTicks = null;
    }
    if (this.hourlyTimer) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    // Best-effort: sell sellable open legs before tearing down the socket so a
    // /stop doesn't abandon live exposure to expiry. Guarded so a dead socket
    // can't hang the teardown.
    const sellPromise = (async () => {
      try {
        await this.pair.sellOpenLegs();
      } catch {
        /* noop */
      }
    })();
    const guard = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([sellPromise, guard]);

    for (const off of this.offFns.splice(0)) {
      try { off(); } catch { /* noop */ }
    }
    this.ws.disconnect();
    useStore.getState().setStatus('idle');
  }

  /**
   * Hot-patch the running config. Only a subset of fields can change mid-run:
   * the "soft" fields that are read at block-evaluation time. Hard fields
   * (symbol, blockMinutes, range-* params, auth) require a /stop + /start.
   */
  patchConfig(patch: Partial<HiLoConfig>): void {
    const soft: Array<keyof HiLoConfig> = [
      'stake',
      'blockTp',
      'blockSl',
      'blockTrail',
      'evStagger',
      'sessionTp',
      'sessionSl',
      'currency',
      'maxConsecutiveLosses',
      'dailyLossCap',
    ];
    const applied: Partial<HiLoConfig> = {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (soft.includes(k as keyof HiLoConfig)) {
        (applied as Record<string, unknown>)[k] = v;
      } else if (v !== (this.cfg as unknown as Record<string, unknown>)[k]) {
        rejected.push(k);
      }
    }
    if (Object.keys(applied).length) {
      Object.assign(this.cfg, applied);
      useStore.getState().setConfig({ ...this.cfg });
    }
    if (rejected.length) {
      throw new Error(
        `cannot change ${rejected.join(', ')} while running — /stop first`,
      );
    }
  }

  getConfig(): Readonly<HiLoConfig> {
    return this.cfg;
  }

  private wireWsEvents(): void {
    this.offFns.push(this.ws.on('tick', (t) => this.onTick(t)));
    this.offFns.push(this.ws.on('ohlc', (o) => this.onOhlc(o)));
    this.offFns.push(this.ws.on('contract', (c) => this.onContract(c)));
    this.offFns.push(this.ws.on('balance', (b) => useStore.getState().setAccount({ balance: b.balance, currency: b.currency })));
    this.offFns.push(this.ws.on('status', (s) => useStore.getState().append('status', `ws ${s}`)));
    this.offFns.push(this.ws.on('error', (msg) => useStore.getState().append('error', msg)));
    this.offFns.push(this.ws.on('info', (msg) => useStore.getState().append('info', msg)));
    this.offFns.push(this.ws.on('reconnect', () => this.onReconnect()));
  }

  private async verifySymbolSupports(): Promise<void> {
    const cf = await this.ws.getContractsFor(this.cfg.symbol);
    const needed = this.cfg.mode === 'no-touch' ? ['NOTOUCH'] : ['HIGHER', 'LOWER'];
    const missing = needed.filter((t) => !cf.contract_types.has(t));
    if (missing.length) {
      const have = [...cf.contract_types].sort().join(', ') || '(none)';
      throw new Error(
        `symbol ${this.cfg.symbol} does not support ${missing.join(' & ')} in mode=${this.cfg.mode}. ` +
          `contracts_for returned: ${have}. Pick a symbol that supports ${needed.join(' & ')}.`,
      );
    }
    // Infer display digits from pip_size (e.g. 0.01 -> 2 digits).
    const pip = cf.pip_size;
    if (pip > 0 && pip < 1) {
      const digits = Math.round(-Math.log10(pip));
      this.pipDigits = digits;
      this.pair.setPipDigits(digits);
    }
    // Hand duration bounds to the pair trader so it can clamp/skip per leg.
    this.pair.setConstraints(cf.constraints);
    for (const t of needed) {
      const c = cf.constraints[t];
      if (c?.minDurationSec !== undefined || c?.maxDurationSec !== undefined) {
        useStore.getState().append(
          'info',
          `${t}: duration ${c.minDurationSec ?? '?'}s..${c.maxDurationSec ?? '?'}s` +
            (c.barrierCategory ? ` · ${c.barrierCategory}` : ''),
        );
      }
    }
  }

  private async loadHistoricalCandles(): Promise<void> {
    const blockSec = blockSeconds(this.cfg);
    // Grab enough history to cover lookbackDays worth of same-TOD bars, plus a
    // safety margin for the ATR fallback. fetchCandlesHistory handles batching
    // past Deriv's 1000-per-request cap internally.
    const bars = HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2);
    try {
      this.candles = await this.ws.fetchCandlesHistory(this.cfg.symbol, blockSec, bars);
      useStore.getState().append('info', `loaded ${this.candles.length} candles @ ${blockSec}s granularity`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('warn', `candle history fetch failed: ${msg} (continuing — ATR fallback unavailable)`);
    }
  }

  private async subscribeLiveCandles(): Promise<void> {
    try {
      await this.ws.getCandles(this.cfg.symbol, blockSeconds(this.cfg), 1, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('warn', `candle subscribe failed: ${msg}`);
    }
  }

  private async bootDryRun(): Promise<void> {
    // Synthesise a plausible candle series so the predictor has something to
    // chew on. This is ONLY for dry-run with no network access — prefer live
    // data whenever possible.
    const blockSec = blockSeconds(this.cfg);
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / blockSec) * blockSec - blockSec * HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2);
    const n = Math.min(5000, HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2));
    let price = 1000;
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const open = price;
      const drift = (Math.random() - 0.5) * 0.4;
      const range = 0.3 + Math.random() * 0.7;
      const high = open + range;
      const low = open - range;
      const close = open + drift + (Math.random() - 0.5) * range;
      out.push({ epoch: start + i * blockSec, open, high, low, close });
      price = close;
    }
    this.candles = out;
    useStore.getState().setSpot(price);
    useStore.getState().setAccount({ type: 'demo', balance: 10000, currency: 'USD' });
    // Currency default for proposal params even though we don't use them.
    if (!this.cfg.currency) this.cfg.currency = 'USD';
    useStore.getState().append('info', `dry-run synthetic candles: ${out.length} @ ${blockSec}s`);
  }

  /**
   * Dry-run tick simulator: emits a tick every ~1s whose magnitude is
   * proportional to the volatility implied by the last few candle ranges.
   * Previously dry-run had no tick feed, so `lastSpot` never moved and the
   * block close was a lie. This keeps the intrabar tracking (and therefore
   * NOTOUCH resolution) honest.
   */
  private startDryRunTicks(): void {
    if (this.dryRunTicks) clearInterval(this.dryRunTicks);
    let price = useStore.getState().lastSpot ?? (this.candles[this.candles.length - 1]?.close ?? 1000);
    useStore.getState().setSpot(price);
    this.dryRunTicks = setInterval(() => {
      if (this.stopped) return;
      const last = this.candles[this.candles.length - 1];
      const range = last ? last.high - last.low : 1;
      // Per-tick σ ~ range/4 scaled for a ~1s tick within a block-long bar.
      const sigma = range / 4 / Math.sqrt(Math.max(1, this.cfg.blockMinutes * 60));
      const drift = (Math.random() - 0.5) * sigma;
      price = Math.max(0.01, price + drift);
      useStore.getState().setSpot(price);
      if (price > this.intraHigh) this.intraHigh = price;
      if (price < this.intraLow) this.intraLow = price;
      // Phase 2: mark the open pair to market so the TP/SL/trail exits can fire
      // in dry-run (there is no server stream to drive onContractUpdate).
      const pair = useStore.getState().currentPair;
      if (pair) this.pair.markToMarket(price, pair.blockEnd);
    }, 1000);
  }

  private onTick(t: TickPayload): void {
    if (t.symbol !== this.cfg.symbol) return;
    useStore.getState().setSpot(t.quote);
    // Track the intrabar high/low so dry-run NOTOUCH can be resolved against
    // real touches instead of exit-spot-only. In live mode this tracking is
    // unused (the server sends actual touch events).
    if (this.cfg.dryRun) {
      if (t.quote > this.intraHigh) this.intraHigh = t.quote;
      if (t.quote < this.intraLow) this.intraLow = t.quote;
    }
  }

  private onOhlc(o: OhlcPayload): void {
    if (o.symbol !== this.cfg.symbol) return;
    // Append or update the last candle. Deriv streams partial candles while
    // they're live and a final update at close.
    const last = this.candles[this.candles.length - 1];
    const bar: Candle = { epoch: o.epoch, open: o.open, high: o.high, low: o.low, close: o.close };
    if (last && last.epoch === bar.epoch) {
      this.candles[this.candles.length - 1] = bar;
    } else {
      this.candles.push(bar);
      if (this.candles.length > 6000) this.candles.splice(0, this.candles.length - 5000);
    }
  }

  private onContract(u: ContractUpdate): void {
    this.pair.onContractUpdate(u);
    this.evaluateSessionGuards();
  }

  private onReconnect(): void {
    const st = useStore.getState();
    st.append('info', 'resubscribing after reconnect');
    this.subscribed = false;
    void (async () => {
      try {
        await this.ws.subscribeTicks(this.cfg.symbol);
        await this.subscribeLiveCandles();
        try {
          await this.ws.subscribeBalance();
        } catch {
          /* best-effort */
        }
        for (const id of this.openContractIds) {
          try { await this.ws.subscribeOpenContract(id); } catch { /* ignore */ }
        }
        this.subscribed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        st.append('error', `resubscribe failed: ${msg}`);
      }
    })();
  }

  private async onBlockStart(w: BlockWindow): Promise<void> {
    if (this.stopped) return;
    if (useStore.getState().halted) return;
    // After a reconnect the candle feed may still be stale — don't predict
    // against an incomplete array.
    if (!this.subscribed) {
      useStore.getState().append('warn', `block ${new Date(w.start * 1000).toISOString().slice(11, 16)}Z — subscriptions not ready, skipping`);
      return;
    }

    const spot = useStore.getState().lastSpot ?? (this.candles[this.candles.length - 1]?.close ?? 0);
    // Fresh block → fresh intrabar tracking for dry-run NOTOUCH resolution.
    this.intraHigh = spot;
    this.intraLow = spot;
    const granularity = blockSeconds(this.cfg);
    const hh = new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z';

    // EV-first path: quote the candidate K grid, pick the highest-EV band,
    // skip the block when even the best EV is below the floor. The band is
    // anchored at the LIVE spot (not the block-open) so the barrier we quote
    // and the barrier we open are the same number.
    if (this.cfg.evMode) {
      const quote = this.makeBandQuote();
      const sel = await selectBand({
        candles: this.candles,
        blockStart: w.start,
        blockEnd: w.end,
        spot,
        mode: this.cfg.mode,
        kCandidates: this.cfg.kCandidates,
        minEv: this.cfg.minEv,
        lookbackDays: this.cfg.lookbackDays,
        regime: regimeFromConfig(this.cfg),
        quote,
      });
      if (!sel) {
        useStore.getState().append('warn', `block ${hh} — no same-TOD history for EV estimation — skipping`);
        return;
      }
      const best = sel.best;
      if (best) {
        const evB = best.evBlock!;
        useStore.getState().append(
          'info',
          `EV scan: K=${best.k.toFixed(2)} → ev ${evB >= 0 ? '+' : ''}${evB.toFixed(2)} (payouts up ${best.payoutUp?.toFixed(2) ?? '–'} dn ${best.payoutDn?.toFixed(2) ?? '–'} · best over ${sel.candidates.length} K values)`,
        );
      }
      if (sel.selectedK === null) {
        useStore.getState().append('warn', `block ${hh} — best combined EV below ${this.cfg.minEv.toFixed(2)} — skipping`);
        return;
      }
      const chosen = sel.best!;
      // Edges come straight from the selector's quote pass, so evStagger sizing
      // needs no extra proposal on the buy.
      const edges = {
        HIGHER: (chosen.truePUp - (chosen.impliedPUp ?? chosen.truePUp)),
        LOWER: (chosen.truePDn - (chosen.impliedPDn ?? chosen.truePDn)),
      };
      await this.pair.openPair({
        blockStart: w.start,
        blockEnd: w.end,
        blockOpen: spot,
        predictedHigh: chosen.predHigh,
        predictedLow: chosen.predLow,
        predictionSource: 'historical',
        daysUsed: sel.model.daysUsed,
        spot,
        evK: chosen.k,
        model: sel.model,
        edges,
      });
      return;
    }

    // Legacy path: fixed-K band from the range predictor. The model is still
    // built from the same excursion statistics so every leg logs p=/ev= and
    // dry-run prices honestly.
    const pred: RangePrediction | null = predictRange(this.candles, w.start, w.end, spot, {
      mode: this.cfg.rangeMode,
      lookbackDays: this.cfg.lookbackDays,
      atrBars: this.cfg.atrBars,
      k: this.cfg.rangeK,
      granularitySec: granularity,
      regime: regimeFromConfig(this.cfg),
    });
    if (!pred) {
      useStore.getState().append('warn', `block ${hh} — no prediction (need more history) — skipping`);
      return;
    }

    let model: WinRateModel | null = null;
    if (pred.meanUp !== undefined && pred.meanDown !== undefined) {
      model = winRateModelFromMeans(pred.meanUp, pred.meanDown, granularity, pred.daysUsed);
    }

    await this.pair.openPair({
      blockStart: w.start,
      blockEnd: w.end,
      blockOpen: pred.blockOpen,
      predictedHigh: pred.predictedHigh,
      predictedLow: pred.predictedLow,
      predictionSource: pred.source,
      daysUsed: pred.daysUsed,
      spot,
      model,
    });
  }

  /**
   * Proposal callback for the EV selector. Quotes the given barrier/duration
   * for one leg and returns { payout, impliedP }. In live mode this is a real
   * Deriv proposal; in dry-run it's the simulated house model.
   */
  private makeBandQuote() {
    const cfg = this.cfg;
    const bar = (price: number) => price.toFixed(this.pipDigits);
    return async (req: {
      side: 'HIGHER' | 'LOWER';
      barrier: number;
      durationSec: number;
      distance: number;
      trueP: number;
      sigmaBlock: number;
    }): Promise<{ payout: number; impliedP: number } | null> => {
      if (cfg.dryRun) {
        const sim = simulateQuote({
          trueP: req.trueP,
          distance: req.distance,
          sigmaBlock: req.sigmaBlock,
          mode: cfg.mode,
          edge: cfg.dryRunEdge ?? 0,
          stake: cfg.stake,
        });
        return sim;
      }
      const contractType = contractTypeFor(cfg.mode, req.side);
      const duration = contractType === 'NOTOUCH'
        ? { duration: cfg.blockMinutes, duration_unit: 'm' as const }
        : { duration: req.durationSec, duration_unit: 's' as const };
      try {
        const p = await this.ws.getProposal({
          amount: cfg.stake,
          currency: cfg.currency,
          contract_type: contractType,
          duration: duration.duration,
          duration_unit: duration.duration_unit,
          symbol: cfg.symbol,
          barrier: bar(req.barrier),
        });
        if (!(p.payout > 0) || p.impliedP === undefined) return null;
        return { payout: p.payout, impliedP: p.impliedP };
      } catch {
        return null;
      }
    };
  }

  private onBlockEnd(w: BlockWindow): void {
    const spot = useStore.getState().lastSpot ?? (this.candles[this.candles.length - 1]?.close ?? 0);
    // In dry-run the synthetic tick stream only produces spot closes; derive a
    // realistic intrabar range (block-level ATR-proportional) so NOTOUCH
    // resolution is meaningful.
    const bar = this.candles.find((c) => c.epoch === w.start);
    const range = bar ? bar.high - bar.low : 0;
    const pair = this.pair.realiseAtBlockEnd(spot, this.intraHigh, this.intraLow, range);
    if (pair) this.recordLedgerRow(pair, w);
    this.evaluateSessionGuards();
  }

  /** Persist one realised block to the ledger (when --ledger is set). */
  private recordLedgerRow(pair: NonNullable<ReturnType<PairTrader['realiseAtBlockEnd']>>, w: BlockWindow): void {
    if (!this.cfg.ledgerPath) return;
    const pnlUp = pair.higher?.liveProfit ?? 0;
    const pnlDn = pair.lower?.liveProfit ?? 0;
    this.recordLedger({
      at: w.start,
      block: new Date(w.start * 1000).toISOString().slice(11, 16) + 'Z',
      mode: this.cfg.mode,
      source: pair.predictionSource,
      daysUsed: pair.daysUsed,
      evK: pair.evK,
      open: pair.blockOpen,
      predH: pair.predictedHigh,
      predL: pair.predictedLow,
      exit: pair.exitReason ?? 'expiry',
      pnlUp,
      pnlDn,
      pnlBlock: pnlUp + pnlDn,
      sessionPnl: useStore.getState().session.totalProfit,
    });
  }

  private evaluateSessionGuards(): void {
    const st = useStore.getState();
    if (st.halted) return;
    const p = st.session.totalProfit;
    let reason = '';
    if (this.cfg.sessionTp !== undefined && p >= this.cfg.sessionTp) {
      reason = `session TP hit: ${p.toFixed(2)} >= ${this.cfg.sessionTp}`;
    } else if (this.cfg.sessionSl !== undefined && p <= -this.cfg.sessionSl) {
      reason = `session SL hit: ${p.toFixed(2)} <= -${this.cfg.sessionSl}`;
    } else if ((this.cfg.maxConsecutiveLosses ?? 0) > 0
      && st.session.consecutiveLosses >= this.cfg.maxConsecutiveLosses!) {
      reason = `circuit-breaker: ${st.session.consecutiveLosses} consecutive losses (max ${this.cfg.maxConsecutiveLosses})`;
    } else if ((this.cfg.dailyLossCap ?? 0) > 0
      && st.session.dayProfit <= -this.cfg.dailyLossCap!) {
      reason = `daily loss cap: today ${st.session.dayProfit.toFixed(2)} <= -${this.cfg.dailyLossCap}`;
    }
    if (reason) {
      st.halt(reason);
      st.append('system', `halted — ${reason}`);
      this.telegram.sendSessionEnd(
        st.session.trades,
        `${p >= 0 ? '+' : ''}${p.toFixed(2)}`,
        `${st.session.trades > 0 ? ((st.session.wins / st.session.trades) * 100).toFixed(0) : '0'}%`,
        reason,
      );
    }
  }

  /** Send an hourly trade summary if any blocks traded this hour. */
  private sendHourlySummary(): void {
    const st = useStore.getState();
    const trades = st.session.trades - this.hourlyTradesBase;
    if (trades <= 0) return;
    const pnl = st.session.totalProfit;
    const wr = st.session.trades > 0 ? `${((st.session.wins / st.session.trades) * 100).toFixed(0)}%` : '0%';
    this.telegram.sendHourly(trades, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`, wr);
    this.hourlyTradesBase = st.session.trades;
  }

  /**
   * Seed the session's day P&L from the ledger so the daily-loss circuit-breaker
   * (and the header card) survive restarts. Runs once per Trader instance.
   */
  private seedDayFromLedger(): void {
    if (this.ledgerSeeded || !this.cfg.ledgerPath) return;
    this.ledgerSeeded = true;
    const rows = loadLedger(this.cfg.ledgerPath);
    if (rows.length === 0) return;
    const today = utcDayKey(Date.now() / 1000);
    const dayPnl = ledgerDayPnl(rows, today);
    useStore.getState().setSessionDay(dayPnl, today);
    useStore.getState().append('info', `ledger: ${rows.length} rows · today ${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(2)} (${today})`);
  }

  /** Append a realised block to the ledger (when --ledger is set). */
  private recordLedger(row: LedgerRow): void {
    if (!this.cfg.ledgerPath) return;
    try {
      appendLedgerRow(this.cfg.ledgerPath, row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('warn', `ledger write failed: ${msg}`);
    }
  }
}
