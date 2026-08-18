import type { DerivWS } from '../services/derivWS';
import type { ContractConstraints, ContractUpdate, HiLoContractType } from '../services/derivWS/types';
import { simulateQuote } from '../engine/dryRunPricing';
import { legSigmaBlock, winRate, type WinRateModel } from '../engine/bandSelector';
import {
  currentWinProb,
  evaluatePairExit,
  markToMarketProfit,
  newExitState,
  staggerStake,
  type ExitState,
} from '../engine/exitLogic';
import { useStore, type LegSide, type LegState, type PairState } from '../state/store';
import type { HiLoConfig, TradeMode } from './config';
import { DEFAULT_TRAIL_ARM_FRACTION } from '../constants/api';

/**
 * Map a (mode, leg-role) pair to the concrete Deriv contract_type.
 *
 * Both modes are STAY-IN-RANGE bets — the difference is the path sensitivity:
 *
 *   higher-lower / upper → LOWER   @ predH  (wins if EXIT spot < predH)
 *   higher-lower / lower → HIGHER  @ predL  (wins if EXIT spot > predL)
 *   no-touch     / upper → NOTOUCH @ predH  (wins if spot NEVER touches predH)
 *   no-touch     / lower → NOTOUCH @ predL  (wins if spot NEVER touches predL)
 *
 * HIGHER/LOWER checks exit-spot only — intrabar breaches are OK as long as
 * price closes back in range. NO TOUCH is strictly stricter: any touch
 * loses. Deriv prices that accordingly — NOTOUCH pays more, HIGHER/LOWER
 * pays less but wins more often.
 *
 * Both HIGHER and LOWER accept absolute or spot-relative barriers per
 * Deriv docs; we always pass absolute prices from the range predictor.
 */
export function contractTypeFor(mode: TradeMode, side: LegSide): HiLoContractType {
  if (mode === 'no-touch') return 'NOTOUCH';
  // Stay-in-range via HIGHER/LOWER:
  //   upper-barrier leg bets price stays BELOW predH → LOWER contract
  //   lower-barrier leg bets price stays ABOVE predL → HIGHER contract
  return side === 'HIGHER' ? 'LOWER' : 'HIGHER';
}

/**
 * Label for logs / leg titles. Arrow points at which barrier the leg
 * is guarding (↑ = upper/predH, ↓ = lower/predL). This is consistent
 * across both modes so users can always read the arrow as "which line".
 */
export function legDisplayName(mode: TradeMode, side: LegSide): string {
  const arrow = side === 'HIGHER' ? '↑' : '↓';
  if (mode === 'no-touch') return `NOTOUCH${arrow}`;
  // HIGHER/LOWER mode: upper leg = LOWER contract, lower leg = HIGHER contract.
  return side === 'HIGHER' ? `LOWER${arrow}` : `HIGHER${arrow}`;
}

export interface OpenPairParams {
  blockStart: number;
  blockEnd: number;
  blockOpen: number;
  predictedHigh: number;
  predictedLow: number;
  predictionSource: 'historical' | 'atr';
  daysUsed: number;
  spot: number;
  /** Selected K in EV mode; undefined in legacy (fixed rangeK) mode. */
  evK?: number;
  /**
   * Volatility model for EV estimation on each leg. Set by the trader for both
   * modes (from predictRange's meanUp/meanDown in legacy, from the selector in
   * EV mode). When null, legs carry no p=/ev= tokens and dry-run falls back to
   * the legacy fixed payout.
   */
  model?: WinRateModel | null;
  /**
   * Per-leg edge (trueP − impliedP) already known from the EV selector's quote
   * pass. Used by evStagger sizing so the buy doesn't need a second proposal.
   * Keyed by side; undefined when not in EV mode (legacy derives the edge from
   * a proposal in openLeg).
   */
  edges?: { HIGHER: number; LOWER: number };
}

export interface PairTraderDeps {
  ws: DerivWS;
  cfg: () => HiLoConfig;
  registerContractId(id: number): void;
  unregisterContractId(id: number): void;
  /** Best-effort Telegram notifier. Undefined = notifications disabled. */
  notify?: import('../services/telegram').TelegramNotifier;
}

interface PrefetchEntry {
  /** Pre-fetched proposal data from getProposal. When present, openLeg uses
   *  buyProposal (skipping the internal getProposal) to eliminate the [PriceMoved]
   *  race where buyContract's getProposal→buy races the other leg's buy. */
  proposalId: string;
  askPrice: number;
  /** Pre-fetched edge (trueP − impliedP) for evStagger sizing. */
  edge: number;
  /** Staggered stake derived from the pre-fetched edge. */
  stake: number;
  /** Pre-fetched payout (stake / impliedP). */
  payout: number;
  /** Pre-fetched implied probability. */
  impliedP: number;
}

function formatBarrier(price: number, digits: number): string {
  // Deriv expects a string barrier. Use fixed digits matching the symbol's
  // pip precision to avoid "invalid barrier" errors.
  return price.toFixed(Math.max(0, Math.min(digits, 8)));
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

/**
 * Owns the two-leg state for the current block: opens HIGHER + LOWER at
 * block-start, subscribes to their P/L streams, and triggers an early sell
 * when the summed live P/L reaches cfg.blockTp. Leg(s) that can't be sold
 * intrabar ride to expiry — their realised P/L merges into the session on
 * block close.
 */
export class PairTrader {
  private pipDigits = 2;
  private selling = false;
  private constraints: Record<string, ContractConstraints> = {};
  /** Volatility model for EV estimation, set per openPair (both modes). */
  private activeModel: WinRateModel | null = null;
  /** Per-block exit accumulator (peak combined P/L, trail-armed flag). */
  private exitState: ExitState = newExitState();
  /** Per-leg edge from the EV selector (evStagger sizing), reset per block. */
  private activeEdges: { HIGHER: number; LOWER: number } | null = null;
  /** Pre-fetched proposals for both legs, used to eliminate the [PriceMoved]
   *  race where buyContract's internal getProposal→buy races the other leg's
   *  buy execution on synthetic indices. */
  private prefetchMap: Map<LegSide, PrefetchEntry> = new Map();

  constructor(private deps: PairTraderDeps) {}

  setPipDigits(d: number): void {
    if (d > 0 && d < 12) this.pipDigits = d;
  }

  setConstraints(c: Record<string, ContractConstraints>): void {
    this.constraints = c;
  }

  /**
   * Fire the HIGHER and LOWER contracts in parallel. Creates the PairState
   * *before* the network calls so contract events that race back to us have
   * a target to land in.
   */
  async openPair(p: OpenPairParams): Promise<void> {
    const cfg = this.deps.cfg();
    const nowSec = Date.now() / 1000;
    const durationSec = Math.max(15, Math.floor(p.blockEnd - nowSec));
    if (durationSec < 15) {
      useStore.getState().append('warn', `block ${timeHM(p.blockStart)} — only ${durationSec}s left, skipping pair`);
      return;
    }

    this.activeModel = p.model ?? null;
    this.activeEdges = p.edges ?? null;
    this.exitState = newExitState();
    this.prefetchMap.clear();
    const spot = p.spot;

    // Initial skeleton — legs filled in as buys return.
    const pair: PairState = {
      blockStart: p.blockStart,
      blockEnd: p.blockEnd,
      blockOpen: p.blockOpen,
      predictedHigh: p.predictedHigh,
      predictedLow: p.predictedLow,
      predictionSource: p.predictionSource,
      daysUsed: p.daysUsed,
      higher: null,
      lower: null,
      tpTriggered: false,
      evK: p.evK,
    };
    useStore.getState().setPair(pair);
    this.selling = false;

    const evTag = cfg.evMode && p.evK !== undefined ? ` · ev K=${p.evK.toFixed(2)}` : '';
    useStore.getState().append(
      'block',
      `new block ${timeHM(p.blockStart)}–${timeHM(p.blockEnd)}  open=${p.blockOpen.toFixed(this.pipDigits)}  predH=${p.predictedHigh.toFixed(this.pipDigits)}  predL=${p.predictedLow.toFixed(this.pipDigits)}  [${cfg.mode} · ${p.predictionSource}${p.daysUsed ? ` ${p.daysUsed}d` : ''}${evTag}]`,
    );

    // ── Pre-fetch proposals for both legs in parallel ──────────────────
    // buyContract does getProposal → buy internally. If both legs call
    // buyContract in parallel, Leg A's buy execution can shift the spot
    // before Leg B's proposal returns → [PriceMoved]. Pre-fetching both
    // proposals first, then executing both buys in parallel, eliminates
    // the race for BOTH modes (EV and legacy).
    const prefetchEntries: Array<{ side: LegSide; barrier: number; durVal: number; durUnit: 's' | 'm'; ct: HiLoContractType; dist: number; trueP: number; targetStake: number; edge: number }> = [];
    if (p.predictedHigh > spot) {
      const ct = contractTypeFor(cfg.mode, 'HIGHER');
      const { value: dv, unit: du } = ct === 'NOTOUCH'
        ? { value: cfg.blockMinutes, unit: 'm' as const }
        : { value: durationSec, unit: 's' as const };
      const dist = Math.abs(p.predictedHigh - spot);
      const trueP = this.activeModel ? winRate(this.activeModel, cfg.mode, 'HIGHER', dist) : 0.5;
      const edge = p.edges?.['HIGHER'] ?? (this.activeEdges?.['HIGHER'] ?? 0);
      const targetStake = cfg.evStagger ? staggerStake({ baseStake: cfg.stake, edge }) : cfg.stake;
      prefetchEntries.push({ side: 'HIGHER', barrier: p.predictedHigh, durVal: dv, durUnit: du, ct, dist, trueP, targetStake, edge });
    }
    if (p.predictedLow < spot) {
      const ct = contractTypeFor(cfg.mode, 'LOWER');
      const { value: dv, unit: du } = ct === 'NOTOUCH'
        ? { value: cfg.blockMinutes, unit: 'm' as const }
        : { value: durationSec, unit: 's' as const };
      const dist = Math.abs(p.predictedLow - spot);
      const trueP = this.activeModel ? winRate(this.activeModel, cfg.mode, 'LOWER', dist) : 0.5;
      const edge = p.edges?.['LOWER'] ?? (this.activeEdges?.['LOWER'] ?? 0);
      const targetStake = cfg.evStagger ? staggerStake({ baseStake: cfg.stake, edge }) : cfg.stake;
      prefetchEntries.push({ side: 'LOWER', barrier: p.predictedLow, durVal: dv, durUnit: du, ct, dist, trueP, targetStake, edge });
    }
    if (prefetchEntries.length > 0) {
      const proposalResults = await Promise.allSettled(
        prefetchEntries.map(l =>
          this.deps.ws.getProposal({
            amount: l.targetStake,
            currency: cfg.currency,
            contract_type: l.ct,
            duration: l.durVal,
            duration_unit: l.durUnit,
            symbol: cfg.symbol,
            barrier: formatBarrier(l.barrier, this.pipDigits),
          }),
        ),
      );
      for (let i = 0; i < prefetchEntries.length; i++) {
        const r = proposalResults[i];
        const entry = prefetchEntries[i]!;
        if (r && r.status === 'fulfilled' && r.value.payout > 0 && r.value.impliedP !== undefined) {
          const impliedP = r.value.impliedP;
          const payout = r.value.payout;
          this.prefetchMap.set(entry.side, {
            proposalId: r.value.id,
            askPrice: r.value.ask_price,
            impliedP,
            edge: entry.edge,
            stake: entry.targetStake,
            payout,
          });
        }
      }
    }

    // Barrier sanity: the upper leg's barrier must be > spot and the lower
    // leg's barrier must be < spot. For HIGHER/LOWER (breakout) and NOTOUCH
    // (stay-in-range) alike, putting a barrier on the wrong side of spot
    // makes the proposal degenerate (payout ≈ stake for HIGHER/LOWER, or
    // instantly lost for NOTOUCH). In EV mode the selector has already
    // guaranteed both are on the right side (anchored at spot); the check is
    // kept defensively.
    const tasks: Array<Promise<void>> = [];
    if (p.predictedHigh > spot) {
      const prefetch = this.prefetchMap.get('HIGHER');
      tasks.push(this.openLeg('HIGHER', p.predictedHigh, durationSec, spot, prefetch));
    } else {
      useStore.getState().append('warn', `upper leg skipped — predH ${p.predictedHigh.toFixed(this.pipDigits)} <= spot ${spot.toFixed(this.pipDigits)}`);
    }
    if (p.predictedLow < spot) {
      const prefetch = this.prefetchMap.get('LOWER');
      tasks.push(this.openLeg('LOWER', p.predictedLow, durationSec, spot, prefetch));
    } else {
      useStore.getState().append('warn', `lower leg skipped — predL ${p.predictedLow.toFixed(this.pipDigits)} >= spot ${spot.toFixed(this.pipDigits)}`);
    }
    await Promise.allSettled(tasks);
  }

  private async openLeg(
    side: LegSide,
    barrier: number,
    durationSec: number,
    spot: number,
    prefetch?: PrefetchEntry,
  ): Promise<void> {
    const cfg = this.deps.cfg();
    const key = side === 'HIGHER' ? 'higher' : 'lower';
    const barrierStr = formatBarrier(barrier, this.pipDigits);

    // Independent estimate of the true win probability at this distance, from
    // the block's volatility model. Used to compute EV vs the quoted impliedP.
    const distance = Math.abs(barrier - spot);
    const model = this.activeModel;
    const trueP = model ? winRate(model, cfg.mode, side, distance) : undefined;

    // In EV mode, we already have precomputed edges from the selector.
    // In legacy mode, we need to compute the edge.
    const edge = prefetch?.edge ?? (cfg.evMode
        ? (this.activeEdges?.[side] ?? 0)
        : (trueP !== undefined && prefetch?.impliedP !== undefined ? trueP - prefetch.impliedP : 0));
    const stake = cfg.evStagger ? staggerStake({ baseStake: cfg.stake, edge }) : cfg.stake;
    const payout = prefetch?.payout ?? (cfg.stake / (prefetch?.impliedP ?? 1/1.95)); // Fallback

    const contractType: HiLoContractType = contractTypeFor(cfg.mode, side);
    const blockSec = cfg.blockMinutes * 60;
    let durationValue: number;
    let durationUnit: 's' | 'm';
    if (contractType === 'NOTOUCH') {
      durationUnit = 'm';
      const startupSlackSec = 2;
      if (durationSec < blockSec - startupSlackSec) {
        const label = legDisplayName(cfg.mode, side);
        useStore.getState().append(
          'warn',
          `${label} skipped — ${durationSec}s left vs full block ${blockSec}s; NOTOUCH only trades fresh blocks`,
        );
        return;
      }
      durationValue = cfg.blockMinutes;
    } else {
      durationUnit = 's';
      durationValue = durationSec;
    }

    const label = legDisplayName(cfg.mode, side);
    const durSpec = `${durationValue}${durationUnit}`;

    // Cross-check against the contracts_for bounds (both are in seconds).
    const effectiveSec = durationUnit === 'm' ? durationValue * 60 : durationValue;
    const cst = this.constraints[contractType];
    const minD = cst?.minDurationSec;
    const maxD = cst?.maxDurationSec;
    if (minD !== undefined && effectiveSec < minD) {
      useStore.getState().append(
        'warn',
        `${label} skipped — ${effectiveSec}s < ${contractType} min ${minD}s`,
      );
      return;
    }
    if (maxD !== undefined && effectiveSec > maxD) {
      useStore.getState().append(
        'warn',
        `${label} ${effectiveSec}s > ${contractType} max ${maxD}s — capping`,
      );
      durationValue = durationUnit === 'm' ? Math.floor(maxD / 60) : maxD;
    }

    if (cfg.dryRun) {
      const fakeId = -Math.floor(Math.random() * 1_000_000_000);
      // Simulated quote: the house prices the leg from its own vol model.
      // When no volatility model exists (legacy path with no same-TOD history),
      // fall back to the old fixed 1.95× payout and a neutral impliedP.
      const sim = trueP !== undefined && model
        ? simulateQuote({
            trueP,
            distance,
            sigmaBlock: legSigmaBlock(model, side),
            mode: cfg.mode,
            edge: cfg.dryRunEdge ?? 0,
            stake: cfg.stake,
          })
        : { impliedP: 1 / 1.95, payout: cfg.stake * 1.95 };
      const impliedP = sim.impliedP;
      const edge = trueP !== undefined ? trueP - impliedP : undefined;
      const stake = cfg.evStagger && edge !== undefined
        ? staggerStake({ baseStake: cfg.stake, edge })
        : cfg.stake;
      // Payout rescales with the (possibly staggered) stake: payout = stake/impliedP.
      const payout = impliedP > 0 ? stake / impliedP : sim.payout;
      const ev = trueP !== undefined && edge !== undefined ? edge * payout : undefined;
      const leg: LegState = {
        side,
        contractId: fakeId,
        stake,
        payout,
        buyPrice: stake,
        barrier,
        liveProfit: 0,
        status: 'open',
        resolved: false,
        impliedP,
        trueP,
        ev,
      };
      this.injectLeg(key, leg);
      const evTokens = ev === undefined || trueP === undefined
        ? ''
        : ` p=${fmtPct(trueP)} ev=${fmtSigned(ev)}`;
      const xToken = cfg.evStagger && stake !== cfg.stake ? ` ×${(stake / cfg.stake).toFixed(2)}` : '';
      useStore.getState().append(
        'trade-open',
        `DRY ${label} stake=${stake.toFixed(2)} payout=${payout.toFixed(2)} barrier=${barrierStr} dur=${durSpec} id=${fakeId}${evTokens}${xToken}`,
      );
      this.deps.notify?.sendTradeOpen(
        `DRY ${timeHM(Date.now() / 1000)}`,
        label,
        barrierStr,
        stake.toFixed(2),
        evTokens.trim() || undefined,
      );
      return;
    }

    // ── Buy ────────────────────────────────────────────────────────────
    // When a pre-fetched proposal is available (parallel pre-fetch in openPair),
    // use buyProposal to skip the internal getProposal → buy round-trip.
    // This eliminates the [PriceMoved] race: buyContract internally calls
    // getProposal first, and if both legs do that in parallel, Leg A's buy
    // execution can shift the spot before Leg B's getProposal returns.
    let leg: LegState;
    if (prefetch) {
      const xToken = cfg.evStagger && prefetch.stake !== cfg.stake
        ? ` ×${(prefetch.stake / cfg.stake).toFixed(2)}`
        : '';
      try {
        const buy = await this.deps.ws.buyProposal(prefetch.proposalId, prefetch.askPrice);
        const impliedP = prefetch.impliedP;
        const ev = trueP !== undefined && impliedP !== undefined
          ? (trueP - impliedP) * prefetch.payout
          : undefined;
        leg = {
          side,
          contractId: buy.contract_id,
          stake: buy.buy_price,
          payout: prefetch.payout,
          buyPrice: buy.buy_price,
          barrier,
          liveProfit: 0,
          status: 'open',
          resolved: false,
          impliedP,
          trueP,
          ev,
        };
        this.deps.registerContractId(buy.contract_id);
        this.injectLeg(key, leg);
        const evTokens = ev === undefined || impliedP === undefined
          ? ''
          : ` p=${fmtPct(trueP!)} ev=${fmtSigned(ev)}`;
        useStore.getState().append(
          'trade-open',
          `${label} stake=${buy.buy_price.toFixed(2)} payout=${prefetch.payout.toFixed(2)} barrier=${barrierStr} dur=${durSpec} id=${buy.contract_id}${evTokens}${xToken}`,
        );
        this.deps.notify?.sendTradeOpen(
          timeHM(Date.now() / 1000),
          label,
          barrierStr,
          buy.buy_price.toFixed(2),
          evTokens || undefined,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useStore.getState().append(
          'error',
          `${label} buy failed (prefetch ${contractType} dur=${durSpec} barrier=${barrierStr}): ${msg}`,
        );
      }
    } else {
      // No pre-fetch (single-leg skip or prefetch failed for this leg) — fall
      // back to buyContract which does getProposal → buy internally. This
      // path races the other leg but is only hit when one leg is skipped or
      // its proposal failed (e.g., degenerate barrier).
      const eff = cfg.evStagger && trueP !== undefined
        ? await this.resolveLiveStake({
            side,
            trueP,
            contractType,
            durationValue,
            durationUnit,
            barrierStr,
          })
        : { stake: cfg.stake, edge: undefined };
      try {
        const res = await this.deps.ws.buyContract({
          amount: eff.stake,
          currency: cfg.currency,
          contract_type: contractType,
          duration: durationValue,
          duration_unit: durationUnit,
          symbol: cfg.symbol,
          barrier: barrierStr,
        });
        const impliedP = res.impliedP;
        const ev = trueP !== undefined && impliedP !== undefined
          ? (trueP - impliedP) * res.payout
          : undefined;
        leg = {
          side,
          contractId: res.contract_id,
          stake: res.buy_price,
          payout: res.payout,
          buyPrice: res.buy_price,
          barrier,
          liveProfit: 0,
          status: 'open',
          resolved: false,
          impliedP,
          trueP,
          ev,
        };
        this.deps.registerContractId(res.contract_id);
        this.injectLeg(key, leg);
        const evTokens = ev === undefined || impliedP === undefined
          ? ''
          : ` p=${fmtPct(trueP!)} ev=${fmtSigned(ev)}`;
        const xToken = cfg.evStagger && eff.edge !== undefined ? ` ×${(eff.stake / cfg.stake).toFixed(2)}` : '';
        useStore.getState().append(
          'trade-open',
          `${label} stake=${res.buy_price.toFixed(2)} payout=${res.payout.toFixed(2)} barrier=${barrierStr} dur=${durSpec} id=${res.contract_id}${evTokens}${xToken}`,
        );
        this.deps.notify?.sendTradeOpen(
          timeHM(Date.now() / 1000),
          label,
          barrierStr,
          res.buy_price.toFixed(2),
          evTokens || undefined,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useStore.getState().append(
          'error',
          `${label} buy failed (${contractType} dur=${durSpec} barrier=${barrierStr}): ${msg}`,
        );
      }
    }
  }

  /**
   * Live evStagger sizing: derive the leg edge (trueP − impliedP) from a
   * proposal, then scale the stake by it. Falls back to the flat stake when the
   * quote fails or impliedP is missing. EV mode skips this entirely — the
   * selector already priced the leg, so the edge comes from `activeEdges`.
   */
  private async resolveLiveStake(args: {
    side: LegSide;
    trueP: number;
    contractType: HiLoContractType;
    durationValue: number;
    durationUnit: 's' | 'm';
    barrierStr: string;
  }): Promise<{ stake: number; edge?: number }> {
    const raw = await this.resolveLiveStakeRaw(args.side, args.trueP, args.contractType, args.durationValue, args.durationUnit, args.barrierStr);
    return { stake: raw.stake, edge: raw.edge };
  }

  /** Raw version (no args wrapper) so openPair can pre-fetch both legs in parallel. */
  private async resolveLiveStakeRaw(
    side: LegSide,
    trueP: number,
    contractType: HiLoContractType,
    durationValue: number,
    durationUnit: 's' | 'm',
    barrierStr: string,
  ): Promise<{ stake: number; edge: number }> {
    const cfg = this.deps.cfg();
    if (cfg.evMode) {
      const edge = this.activeEdges?.[side] ?? 0;
      return { stake: staggerStake({ baseStake: cfg.stake, edge }), edge };
    }
    try {
      const p = await this.deps.ws.getProposal({
        amount: cfg.stake,
        currency: cfg.currency,
        contract_type: contractType,
        duration: durationValue,
        duration_unit: durationUnit,
        symbol: cfg.symbol,
        barrier: barrierStr,
      });
      if (p.impliedP === undefined) return { stake: cfg.stake, edge: 0 };
      const edge = trueP - p.impliedP;
      return { stake: staggerStake({ baseStake: cfg.stake, edge }), edge };
    } catch {
      return { stake: cfg.stake, edge: 0 };
    }
  }

  private injectLeg(key: 'higher' | 'lower', leg: LegState): void {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    st.setPair({ ...pair, [key]: leg });
  }

  /**
   * Call from the global contract-update stream. Routes to the matching leg
   * and re-evaluates the pair TP.
   */
  onContractUpdate(u: ContractUpdate): void {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    const side: LegSide | null =
      pair.higher?.contractId === u.contract_id ? 'HIGHER'
      : pair.lower?.contractId === u.contract_id ? 'LOWER'
      : null;
    if (!side) return;

    const patch: Partial<LegState> = {
      liveProfit: u.profit ?? 0,
      bidPrice: u.bid_price,
      isValidToSell: u.is_valid_to_sell,
    };
    const status = u.status;
    if (status === 'open' || status === 'won' || status === 'lost' || status === 'sold' || status === 'cancelled') {
      patch.status = status;
      if (status !== 'open') patch.resolved = true;
    }
    st.updateLeg(side, patch);

    // Re-read the merged pair before deciding TP.
    const updated = useStore.getState().currentPair;
    if (updated) this.maybeTriggerTp(updated);

    // When a leg resolves (naturally or by sell), drop its contract id from
    // the global registration so reconnect logic doesn't try to resubscribe.
    if (patch.resolved && u.contract_id) {
      this.deps.unregisterContractId(u.contract_id);
    }
  }

  /**
   * Evaluate TP / SL / trailing exit on every contract update. The trail state
   * (intrabar peak + arming flag) lives in `exitState`, reset per block. When a
   * leg resolves, only the still-open legs are candidates — a won leg's payout
   * is already banked, a lost leg is gone.
   */
  private maybeTriggerTp(pair: PairState): void {
    if (pair.tpTriggered || this.selling) return;
    const cfg = this.deps.cfg();
    const profit = (pair.higher?.liveProfit ?? 0) + (pair.lower?.liveProfit ?? 0);
    const open = [pair.higher, pair.lower].filter((l): l is LegState => !!l && !l.resolved);
    if (open.length === 0) return;

    const blockTp = cfg.blockTp ?? 0;
    const blockSl = cfg.blockSl ?? 0;
    const blockTrail = cfg.blockTrail ?? 0;
    const trailArmAt = blockTp > 0 && blockTrail > 0 ? blockTp * DEFAULT_TRAIL_ARM_FRACTION : 0;

    const dec = evaluatePairExit({
      state: this.exitState,
      profit,
      blockTp,
      blockSl,
      blockTrail,
      trailArmAt,
    });
    if (!dec.exit) return;

    this.selling = true;
    useStore.getState().markTpTriggered(dec.reason);
    const reason =
      dec.reason === 'sl'
        ? `pair P/L ${profit <= 0 ? '' : '+'}${profit.toFixed(2)} <= -sl ${blockSl.toFixed(2)}`
        : dec.reason === 'trail'
          ? `pair P/L retraced ${(this.exitState.peakPL - profit).toFixed(2)} from peak +${this.exitState.peakPL.toFixed(2)}`
          : `pair P/L ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} >= tp ${blockTp.toFixed(2)}`;
    useStore.getState().append('sell', `${reason} — selling sellable legs`);
    void this.sellSellableLegs(pair);
  }

  private async sellSellableLegs(pair: PairState): Promise<void> {
    const cfg = this.deps.cfg();
    const jobs: Array<Promise<void>> = [];
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.mode, leg.side);
      if (cfg.dryRun) {
        // Simulate an immediate sell at the current live profit.
        useStore.getState().updateLeg(leg.side, {
          status: 'sold',
          resolved: true,
        });
        useStore.getState().append('sell', `DRY ${label} id=${leg.contractId} sold @ +${leg.liveProfit.toFixed(2)}`);
        continue;
      }
      if (leg.isValidToSell !== 1) {
        useStore.getState().append('warn', `${label} id=${leg.contractId} not sellable right now — riding to expiry`);
        continue;
      }
      jobs.push(this.sellOne(leg, label));
    }
    await Promise.allSettled(jobs);
  }

  private async sellOne(leg: LegState, label: string): Promise<void> {
    try {
      const res = await this.deps.ws.sellContract(leg.contractId, 0);
      // Realise the sold leg at the ACTUAL sale price (buy_price is what we
      // paid; sold_for is what we got). Without this, the leg's liveProfit
      // keeps streaming the pre-sale value and the block realise double-counts.
      const realised = (res.sold_for ?? leg.liveProfit ?? 0) - (leg.buyPrice ?? leg.stake);
      useStore.getState().updateLeg(leg.side, {
        status: 'sold',
        resolved: true,
        liveProfit: realised,
      });
      useStore.getState().append('sell', `${label} id=${leg.contractId} sold_for=${res.sold_for.toFixed(2)} realised=${realised >= 0 ? '+' : ''}${realised.toFixed(2)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('error', `${label} id=${leg.contractId} sell failed: ${msg}`);
    }
  }

  /**
   * Sell any open, sellable legs (used on /stop so live exposure isn't
   * abandoned to expiry). Non-sellable legs ride to expiry — same rule as the
   * block TP path.
   */
  async sellOpenLegs(): Promise<void> {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    const cfg = this.deps.cfg();
    const jobs: Array<Promise<void>> = [];
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.mode, leg.side);
      if (cfg.dryRun) {
        // Simulate an immediate market sale at the current live profit.
        st.updateLeg(leg.side, { status: 'sold', resolved: true });
        st.append('sell', `DRY ${label} id=${leg.contractId} sold @ +${leg.liveProfit.toFixed(2)}`);
        continue;
      }
      if (leg.isValidToSell !== 1) {
        st.append('warn', `${label} id=${leg.contractId} not sellable right now — riding to expiry`);
        continue;
      }
      jobs.push(this.sellOne(leg, label));
    }
    await Promise.allSettled(jobs);
  }

  /**
   * Dry-run mark-to-market: re-price each open leg from the CURRENT spot and
   * the remaining block time, then re-evaluate the TP/SL/trail exits. Live mode
   * never calls this — the server's proposal_open_contract stream drives
   * onContractUpdate instead.
   */
  markToMarket(spot: number, blockEnd: number): void {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    const cfg = this.deps.cfg();
    const model = this.activeModel;
    const secsRemaining = Math.max(0, blockEnd - Date.now() / 1000);
    let touched = false;

    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const distance = Math.abs(spot - leg.barrier);
      const sigma = model ? legSigmaBlock(model, leg.side) / Math.sqrt(model.ticks) : undefined;
      const w = sigma !== undefined && sigma > 0 && secsRemaining > 0
        ? currentWinProb({ distance, sigmaPerTick: sigma, secondsRemaining: secsRemaining, mode: cfg.mode })
        : 0.5;
      const profit = markToMarketProfit({ payout: leg.payout, stake: leg.stake, currentWinP: w });
      st.updateLeg(leg.side, { liveProfit: profit });
      touched = true;
    }

    if (touched) {
      const updated = useStore.getState().currentPair;
      if (updated) this.maybeTriggerTp(updated);
    }
  }

  /** Used by /stop in dry-run: decide the current exit intent from live P/L. */
  exitIntent(profit: number): { exit: boolean; reason?: 'tp' | 'trail' | 'sl' } {
    const cfg = this.deps.cfg();
    const blockTp = cfg.blockTp ?? 0;
    const blockSl = cfg.blockSl ?? 0;
    const blockTrail = cfg.blockTrail ?? 0;
    const trailArmAt = blockTp > 0 && blockTrail > 0 ? blockTp * DEFAULT_TRAIL_ARM_FRACTION : 0;
    return evaluatePairExit({
      state: this.exitState,
      profit,
      blockTp,
      blockSl,
      blockTrail,
      trailArmAt,
    });
  }

  /**
   * Called from BlockClock's 'block-end' handler. For the dry-run path, we
   * need to resolve any still-open legs against the last known spot since
   * there's no server event to do it for us.
   *
   * `intraHigh` / `intraLow` / `barRange` let dry-run resolve NOTOUCH against
   * a realistic intrabar range (a NOTOUCH loses on ANY touch, not just on the
   * exit spot). Where no intrabar info is available we fall back to the exit
   * spot only, matching legacy behaviour.
   */
  realiseAtBlockEnd(
    spot: number,
    intraHigh = -Infinity,
    intraLow = Infinity,
    barRange = 0,
  ): PairState | null {
    const cfg = this.deps.cfg();
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return null;

    if (cfg.dryRun) {
      for (const leg of [pair.higher, pair.lower]) {
        if (!leg || leg.resolved) continue;
        const label = legDisplayName(cfg.mode, leg.side);
        // Exit-spot rule (all modes):
        //   upper leg (barrier=predH): wins if exit spot stays below predH
        //   lower leg (barrier=predL): wins if exit spot stays above predL
        let won = leg.side === 'HIGHER' ? spot < leg.barrier : spot > leg.barrier;
        // NOTOUCH additionally loses if the barrier was ever touched intrabar.
        if (cfg.mode === 'no-touch') {
          const touched =
            leg.side === 'HIGHER'
              ? intraHigh >= leg.barrier
              : intraLow <= leg.barrier;
          if (touched) won = false;
        }
        // In dry-run no tick feed exists (legacy path): widen the exit-spot
        // verdict by barRange as a conservative proxy for intrabar motion.
        if (cfg.mode === 'no-touch' && !Number.isFinite(intraHigh)) {
          const touched =
            leg.side === 'HIGHER'
              ? spot + barRange / 2 >= leg.barrier
              : spot - barRange / 2 <= leg.barrier;
          if (touched) won = false;
        }
        const profit = won ? leg.payout - leg.stake : -leg.stake;
        st.updateLeg(leg.side, {
          status: won ? 'won' : 'lost',
          resolved: true,
          liveProfit: profit,
        });
        st.append('trade-close', `DRY ${won ? 'WIN' : 'LOSS'} ${label} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} exit=${spot.toFixed(this.pipDigits)} barrier=${leg.barrier.toFixed(this.pipDigits)}`);
      }
    }

    const finalPair = useStore.getState().currentPair;
    if (!finalPair) return null;
    // A block that neither TP/SL/trail sold rides to expiry — label it for the ledger.
    if (!finalPair.tpTriggered) {
      useStore.getState().setPair({ ...finalPair, exitReason: 'expiry' });
    }
    const realised = legProfit(finalPair.higher) + legProfit(finalPair.lower);
    // Win/loss accounting is per-BLOCK (the unit of capital risk): a block is
    // a win when it net-profited, a loss when net-negative. The session trade
    // count and win rate therefore reflect block outcomes, not leg outcomes.
    const legs = { won: 0, lost: 0 };
    for (const leg of [finalPair.higher, finalPair.lower]) {
      if (!leg) continue;
      if (leg.status === 'won' || leg.status === 'sold') legs.won++;
      else legs.lost++;
    }
    useStore.getState().addSessionResult(realised, legs);
    const sessAfter = useStore.getState().session.totalProfit;
    useStore.getState().append(
      'trade-close',
      `block ${timeHM(finalPair.blockStart)} realised: ${realised >= 0 ? '+' : ''}${realised.toFixed(2)} ` +
        `(H ${legProfit(finalPair.higher).toFixed(2)} / L ${legProfit(finalPair.lower).toFixed(2)}) ` +
        `sess ${sessAfter >= 0 ? '+' : ''}${sessAfter.toFixed(2)}`,
    );
    const legsStr = finalPair.higher
      ? `${finalPair.higher.status} ${finalPair.higher.liveProfit >= 0 ? '+' : ''}${finalPair.higher.liveProfit.toFixed(2)}`
      : '—';
    const lowerStr = finalPair.lower
      ? `${finalPair.lower.status} ${finalPair.lower.liveProfit >= 0 ? '+' : ''}${finalPair.lower.liveProfit.toFixed(2)}`
      : '—';
    this.deps.notify?.sendTradeResult(
      `${realised >= 0 ? '+' : ''}${realised.toFixed(2)}`,
      `H ${legsStr} · L ${lowerStr}`,
      {
        trades: useStore.getState().session.trades,
        wins: useStore.getState().session.wins,
        losses: useStore.getState().session.losses,
        winRate: useStore.getState().session.trades > 0
          ? `${((useStore.getState().session.wins / useStore.getState().session.trades) * 100).toFixed(0)}%`
          : '0%',
        netPnl: `${useStore.getState().session.totalProfit >= 0 ? '+' : ''}${useStore.getState().session.totalProfit.toFixed(2)}`,
      },
    );
    return useStore.getState().finalisePair();
  }
}

function legProfit(leg: LegState | null): number {
  if (!leg) return 0;
  return leg.liveProfit ?? 0;
}

function timeHM(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return d.toISOString().slice(11, 16) + 'Z';
}
