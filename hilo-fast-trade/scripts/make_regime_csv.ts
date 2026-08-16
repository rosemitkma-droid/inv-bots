/**
 * Phase 4 validation fixture — a 30-day synthetic candle CSV with a volatility
 * REGIME SHIFT, generated deterministically (mulberry32 + box-muller, no
 * Math.random) so backtest runs are reproducible.
 *
 *   days  1–10:  low vol    (σ = 1)
 *   days 11–15:  RAMPING    (σ = 1.5, 2, 2.5, 3, 3) — this is the part that
 *                 produces negative realised P&L: actual vol EXCEEDS the
 *                 trailing recent-vol window, so a fair-from-recent house
 *                 underprices vol.
 *   days 16–25:  high vol   (σ = 3)
 *   days 26–30:  back to low (σ = 1)
 *
 * Per block (self-consistent with the reflection model E[max] = 0.798·σClose):
 *   high = open + σ·|N|,  low = open − σ·|N|,
 *   close = open + N(0, 1.253·σ),  open = prev close.
 *
 * Usage:
 *   bun scripts/make_regime_csv.ts [seed] > regime.csv
 * Then backtest it, e.g.:
 *   bun src/index.tsx --backtest --csv regime.csv --block-minutes 3 \
 *     --lookback-days 15 --ev-mode --backtest-edge 0
 *   (blend 0 default: many trades, phantom avg EV > 0, realized ≈ 0)
 *   ... --regime-blend 1 → ~0 trades (our σ == house recent σ)
 *   ... --regime-blend 0.7 → few trades (residual gap gated by minEv)
 *   Add --backtest-edge 0.05 → blend 0 trades AND realises a loss.
 */

// ─── Deterministic RNG (mulberry32) + Gaussian (box-muller) ──────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGauss(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

// ─── Fixture parameters ──────────────────────────────────────────────────────
const BLOCK_SEC = 180;          // 3-minute blocks
const BLOCKS_PER_DAY = 86_400 / BLOCK_SEC; // 480
const DAYS = 30;
const N = DAYS * BLOCKS_PER_DAY;
// Anchored to a fixed UTC midnight (2027-01-01T00:00:00Z) so blocks align.
const MIDNIGHT = 1_798_761_600;

const BASE_VOL = 1.0;
function volForDay(day: number): number {
  // day is 1-based.
  if (day <= 10) return BASE_VOL;            // low
  if (day <= 15) return BASE_VOL * (1 + 0.5 * (day - 10)); // ramp 1.5,2,2.5,3,3
  if (day <= 25) return BASE_VOL * 3;        // high
  return BASE_VOL;                            // back to low
}

// ─── Generate ────────────────────────────────────────────────────────────────
const seed = Number(process.argv[2] ?? 42);
const rng = mulberry32(seed);
const gauss = makeGauss(rng);

const rows: string[] = [];
let price = 1000;
for (let i = 0; i < N; i++) {
  const day = Math.floor(i / BLOCKS_PER_DAY) + 1;
  const sigma = volForDay(day);
  const open = price;
  const up = sigma * Math.abs(gauss());
  const dn = sigma * Math.abs(gauss());
  const high = open + up;
  const low = open - dn;
  const close = open + sigma * 1.253 * gauss();
  const epoch = MIDNIGHT + i * BLOCK_SEC;
  rows.push(`${epoch},${open.toFixed(4)},${high.toFixed(4)},${low.toFixed(4)},${close.toFixed(4)}`);
  price = close;
}

process.stdout.write(rows.join('\n') + '\n');
