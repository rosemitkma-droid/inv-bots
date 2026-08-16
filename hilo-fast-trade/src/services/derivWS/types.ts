/**
 * Deriv contract types this CLI can place. HIGHER/LOWER are breakout bets
 * (win if exit past barrier); NOTOUCH is a stay-in-range bet (win if spot
 * never touches the barrier during the contract life).
 */
export type HiLoContractType = 'HIGHER' | 'LOWER' | 'NOTOUCH';
export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';

export interface ProposalParams {
  amount: number;
  currency: string;
  contract_type: HiLoContractType;
  duration: number;
  duration_unit: DurationUnit;
  symbol: string;
  basis?: 'stake' | 'payout';
  /**
   * Absolute price barrier (e.g. "1234.56") or spot-relative (e.g. "+0.5").
   * Required for all three contract types — omitted these contracts won't
   * resolve predictably. For time-block trading we always pass an absolute
   * value computed from the range predictor.
   */
  barrier: string;
}

export interface ProposalResult {
  id: string;
  ask_price: number;
  payout: number;
  spot: number;
  /**
   * Market-implied win probability for this quote: `ask_price / payout`.
   * The single most useful number from a Deriv proposal — everything else
   * (house edge, EV) is derived from it against an independent estimate of
   * the true win probability.
   */
  impliedP?: number;
}

export interface BuyResult {
  contract_id: number;
  buy_price: number;
  payout: number;
  purchase_time: number;
  start_time: number;
  longcode: string;
  shortcode: string;
  transaction_id: number;
  balance_after?: number;
  /** Market-implied win probability (ask/payout) from the buy-time proposal. */
  impliedP?: number;
}

export interface SellResult {
  contract_id: number;
  sold_for: number;
  balance_after?: number;
  reference_id?: number;
  transaction_id?: number;
}

export interface ContractUpdate {
  contract_id: number;
  is_sold: number;
  status?: 'open' | 'won' | 'lost' | 'sold' | 'cancelled';
  profit?: number;
  payout?: number;
  buy_price?: number;
  bid_price?: number;
  entry_spot?: number;
  current_spot?: number;
  exit_tick?: number;
  is_valid_to_sell?: number;
  date_expiry?: number;
  shortcode?: string;
  barrier?: string;
}

export interface TickPayload {
  epoch: number;
  quote: number;
  symbol: string;
  pip_size: number;
  id?: string;
}

export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OhlcPayload extends Candle {
  symbol: string;
  granularity: number;
}

export interface BalancePayload {
  balance: number;
  currency: string;
  loginid?: string;
}

export interface PortfolioContract {
  contract_id: number;
  contract_type: string;
  buy_price: number;
  payout: number;
  symbol?: string;
  longcode?: string;
  shortcode?: string;
  purchase_time?: number;
  expiry_time?: number;
}

export interface ContractConstraints {
  /** Minimum contract duration in seconds (ticks treated as ~1s for 1HZ synthetics). */
  minDurationSec?: number;
  maxDurationSec?: number;
  /** 'american' = barrier can be touched any time during life; 'european' = only at expiry. */
  barrierCategory?: string;
}

export interface ContractsForResult {
  symbol: string;
  contract_types: Set<string>;
  pip_size: number;
  /** Per-contract-type duration / barrier constraints parsed from contracts_for.available[]. */
  constraints: Record<string, ContractConstraints>;
}

export interface DerivWSOptions {
  appId: string;
  token: string;
  accountId?: string;
  preferAccountType?: 'demo' | 'real';
}
