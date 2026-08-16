/**
 * Dry-run quote simulation (Phase 1).
 *
 * A real Deriv proposal derives impliedP = ask/payout from the house's OWN
 * volatility model. To make dry-run honest — and to give the EV selector a
 * controllable, K-discriminating edge to discover — we model the house as
 * pricing from our calibrated volatility scaled by (1 + edge):
 *
 *   z_ours   = distance / (σ·√T)          (our model's distance in block-vols)
 *   z_house  = z_ours / (1 + edge)        (house thinks vol is (1+edge)·σ)
 *   impliedP = winRateFromZ(z_house, mode)
 *   payout   = stake / impliedP           (ask/payout ≡ impliedP by construction)
 *
 * Sign convention: edge > 0 means the house thinks vol is HIGHER than we do,
 * so it prices stay-in-range wins as LESS likely (cheaper payout) → positive
 * EV for us at the same distance. Edge 0 = fair house → EV ≈ 0 everywhere.
 * The default dryRunEdge is +0.03, so out-of-the-box dry-run correctly shows
 * slightly negative EV and the selector skips blocks — flip edge negative (or
 * lower minEv) to see it pick a band.
 */

import type { TradeMode } from '../trading/config';
import { winRateFromZ } from './bandSelector';

export interface SimulatedQuote {
  payout: number;
  impliedP: number;
}

export function simulateQuote(args: {
  trueP: number;
  distance: number;
  sigmaBlock: number;
  mode: TradeMode;
  edge: number;
  stake: number;
}): SimulatedQuote {
  const { distance, sigmaBlock, mode, edge, stake } = args;
  if (!(sigmaBlock > 0) || !(distance > 0)) {
    return { payout: stake * 2, impliedP: 0.5 };
  }
  const z = distance / sigmaBlock;
  const zHouse = z / (1 + edge);
  const impliedP = clampP(winRateFromZ(zHouse, mode));
  return { impliedP, payout: stake / impliedP };
}

/**
 * Keep the simulated house's probability inside a sane band. The ceiling is
 * deliberately high so a FAIR house (edge=0) reproduces trueP exactly and
 * EV ≡ 0 — only the very far tail (z ≳ 2.6) gets clamped, mimicking a real
 * house that won't price a near-certainty at 0.999.
 */
function clampP(p: number): number {
  return Math.min(0.995, Math.max(0.02, p));
}
