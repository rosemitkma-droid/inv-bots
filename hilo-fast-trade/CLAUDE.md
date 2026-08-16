# HiLo-Fast — project guide for Claude

Time-block paired Deriv CLI. Computes a non-repainting predicted high /
predicted low per N-minute block, then opens TWO Deriv contracts at every
fresh block boundary — one guarding the upper line (predH), one the lower
(predL) — streams their live P/L, and closes the pair early when their
summed profit hits a block-TP target.

Both modes are **stay-in-range** bets (price should end up / remain inside
`[predL, predH]`); they differ only in path sensitivity:

- **higher-lower** (default): LOWER @ predH + HIGHER @ predL. Checks
  EXIT spot only — intrabar breaches that come back are fine. Lower payout,
  higher win rate.
- **no-touch**: NOTOUCH @ predH + NOTOUCH @ predL. Any intrabar touch of
  either barrier loses that leg. Higher payout, lower win rate.

## Runtime

- **Bun + TypeScript** (no Node). Scripts in `package.json`. Strict TS; JSX via `react-jsx`.
- **Ink 5 + React 18** for the TUI. `Zustand v5` (`create` from `zustand`) for state.
- Entry: `src/index.tsx`. Default renders the Ink TUI; `--no-ui` falls back to plain coloured stdout logs.
- Dev loop: `bun run typecheck`, `bun src/index.tsx --dry-run`.

## Layout

```
src/
  index.tsx                 # argv parse → setConfig → render <App/> (or plain log if --no-ui)
  cli/args.ts               # flag/env parser. Env overrides defaults; flags override env.
  cli/backtest.ts           # `--backtest` runner: load candles (--csv or live), print stats, exit
  constants/api.ts          # Deriv URLs, defaults (symbol, stake, block size, TP, mode, etc.)
  engine/
    blockClock.ts           # wall-clock, UTC-midnight-aligned block emitter (block-start / block-end)
    rangePredictor.ts       # pure function: candles → { blockOpen, predictedHigh, predictedLow, source }
    bandSelector.ts         # Phase 1: EV-first band selection (win-rate model + K grid quoting)
    dryRunPricing.ts        # Simulated house quote for dry-run (edge-scaled vol)
    exitLogic.ts            # Phase 2: TP/SL/trail exit decisions, edge-scaled stake, dry-run mark-to-market
    ledger.ts               # Phase 3: append-only CSV block ledger (row, parse, day P&L)
    backtest.ts             # Phase 3: replay candle history block-by-block → win rate / P&L / expectancy
    regime.ts               # Phase 4: recent-realized-vol measure + blend into same-TOD means (regimeFromConfig)
  services/
    derivRest.ts            # OAuth listAccounts + getOtpUrl (one-time auth URL)
    derivWS/
      client.ts             # Deriv WS client: session rollover, reconnect, proposal/buy/sell, candles, contracts_for
      types.ts              # Public types (HiLoContractType, ContractUpdate, Candle, ContractConstraints, …)
      normalize.ts          # Raw-payload → typed-payload conversions
      index.ts              # Barrel re-export
  trading/
    config.ts               # HiLoConfig (symbol, stake, blockMinutes, mode, blockTp, sessionTp/Sl, evMode, …) + TradeMode union
    trader.ts               # Main bot: connect, candles, blockClock → onBlockStart → openPair, onBlockEnd → realise
    pairTrader.ts           # Owns current-block pair state; opens both legs; TP-driven sell; dispatches contract_type per mode
  state/
    store.ts                # Zustand store: config, status, account, lastSpot, currentPair, session, transcript, menuStack
  ui/
    App.tsx                 # Top-level Ink layout; owns Trader ref via CmdCtx; gates Prompt vs SelectMenu on menuStack
    Header.tsx              # Banner + 3-card row (MARKET, BLOCK, SESSION)
    BlockPanel.tsx          # ACTIVE PAIR panel: two leg boxes + TP progress bar (mode-aware labels)
    Transcript.tsx          # Last 30 log lines (Row components)
    Prompt.tsx              # `❯` input with /-autocomplete menu, history, Esc/Tab/Enter
    SelectMenu.tsx          # Nested-menu renderer driven by store.menuStack (↑↓, 1–9, Enter, Esc/←)
    Footer.tsx              # `/help · /start · /quit · Ctrl+C · clock`
    commands.ts             # Slash-command registry + dispatcher + patchCfg + submenu builders
    theme.ts                # Colour palette + fmtMoney/fmtPrice/fmtTime/fmtCountdown
    header/                 # Banner, StatusPill, MarketCard, BlockCard, SessionCard, primitives (Card/Metric/Gauge)
    transcript/             # Row.tsx, body.tsx (kind routers), labels.ts, kv.tsx
```

## Slash commands (src/ui/commands.ts)

- **Lifecycle**: `/start`, `/stop` (alias `/halt`), `/quit` (aliases `/exit`, `/q`), `/reset` (clears a session TP/SL halt and resets session stats). `/start` also clears any pending halt, so a halted session can always be resumed.
- **Soft config** (hot-swap; affects the current and future blocks):
  `/block-tp <usd>` (aliases `/tp`, `/btp`), `/block-sl <usd|off>` (alias `/bsl`),
  `/block-trail <usd|off>` (aliases `/trail`, `/btrail`), `/stagger [on|off]`,
  `/session-tp <usd|off>` (alias `/stp`), `/session-sl <usd|off>` (alias `/ssl`),
  `/stake <usd>`.
- **Hard config** (auto-stops the bot; user must `/start` again to re-validate):
  `/mode [higher-lower|no-touch]`, `/range-mode [hybrid|historical|atr]` (alias `/rm`),
  `/symbol <sym>`, `/block <min>`.
- **Introspection**: `/status` (alias `/st`), `/cfg`, `/clear` (alias `/cls`), `/help` (alias `/?`).

`/mode` and `/range-mode` pushed with no argument open a nested SelectMenu
(numbered picker, ↑↓ / 1–9 / Enter / Esc). Direct-arg form bypasses the menu.

The Trader exposes `patchConfig(patch)` which accepts the **soft** set only and
throws on hard-field changes. `commands.ts::patchCfg` routes through
`trader.patchConfig` when a Trader exists, or writes the store directly when
idle. One `setConfig` call per patch — the store notifies subscribers exactly once.

## Deriv API primitives used

- **Auth**: REST `listAccounts` → `getOtpUrl` → `wss://.../ws/demo?otp=…`. No legacy `authorize` flow.
- **Candles**: `ticks_history` with `style=candles`, `granularity = blockMinutes * 60`. Allowed granularities: 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400 (validated upfront by `assertBlockGranularity` in `constants/api.ts`; `--block-minutes` must map to one). Live updates stream via the `ohlc` msg_type when `subscribe: 1`.
- **Proposal**: `{proposal:1, contract_type:'HIGHER'|'LOWER'|'NOTOUCH', amount, basis:'stake', currency, duration, duration_unit, underlying_symbol, barrier}`. Barrier is an absolute price string from the predictor (`+N` / `-N` relative forms are also accepted by Deriv but we always pass absolute).
  - `duration_unit` depends on contract type:
    - `HIGHER` / `LOWER`: `'s'` (seconds) — full block-end resolution works.
    - `NOTOUCH`: `'m'` (minutes) — synthetics only offer minute-resolution NOTOUCH, even though `contracts_for` reports a wider `5s..31536000s` range. Submitting seconds returns `"Trading is not offered for this duration"`. We round to `cfg.blockMinutes`.
- **Buy**: `{buy: proposal.id, price: ask_price * (1 + slippagePct), subscribe: 1}`. Default 10% slippage pad; setting `price = ask_price` exactly would bounce with `[PriceMoved]` on any intrabar drift between proposal and buy dispatch.
- **Live P/L**: `proposal_open_contract` subscription; read `profit`, `bid_price`, `is_valid_to_sell`, `status` ('open'|'won'|'lost'|'sold'|'cancelled').
- **Sell**: `{sell: contract_id, price: 0}` where 0 = accept market. **Only call when `is_valid_to_sell === 1`** — Deriv rejects sells otherwise. Non-sellable legs ride to expiry.
- **Symbol guard**: `contracts_for` must list the contract type(s) required by the current mode — `HIGHER` and `LOWER` for `higher-lower`, or `NOTOUCH` for `no-touch`. `Trader.verifySymbolSupports` also extracts per-contract-type duration bounds (`min_contract_duration` / `max_contract_duration`) and hands them to `PairTrader.setConstraints` for pre-submit validation, so we fail fast with clear warnings instead of eating server errors.

## EV-first band selection (`--ev-mode`)

Phase 1 re-prices the band from the LIVE quote instead of trusting history alone.
`engine/bandSelector.ts` is the pure core; `trader.ts::makeBandQuote` supplies the
quote callback; `engine/dryRunPricing.ts` simulates the house when dry-run.

- **Selection.** At block-start (when `cfg.evMode`), `Trader.onBlockStart` calls
  `selectBand` over `cfg.kCandidates`: for each K it computes
  `predH = spot + K·mean_up`, `predL = spot − K·mean_dn`, estimates each leg's
  true win-rate from a calibrated random-walk model (`winRateFromZ`: `Φ(z)` for
  HIGHER/LOWER, `2Φ(z)−1` for NOTOUCH, where `z = distance/(σ·√T)` and σ is
  calibrated from same-TOD mean excursion via `E[max] = σ·√(2T/π)`), quotes the
  barrier through Deriv, and forms `legEV = (trueP − impliedP)·payout`. It picks
  the K maximising combined EV and opens only if `bestEV ≥ cfg.minEv` — otherwise
  the block is skipped (a `warn` line explains why).
- **Band is anchored at live spot.** The selector sets `blockOpen = spot`, so the
  quoted barrier, the submitted barrier, and the opened leg's barrier are the same
  number. The legacy fixed-K path still uses the block-open candle.
- **EV is measured, not assumed.** `impliedP = ask/payout` comes from the proposal;
  `trueP` from our model. `LegState` carries `impliedP`/`trueP`/`ev`, and each
  trade-open line appends `p=<pct>` and `ev=<±$>` tokens (coloured violet/gold in
  `kv.tsx`). Legacy mode logs the same tokens at `rangeK` — so EV is *measured* in
  both modes, *acted on* only in EV mode.
- **Dry-run edge.** Dry-run can't quote Deriv, so `simulateQuote` prices each leg
  as `impliedP = winRateFromZ(z/(1+edge), mode)` with `payout = stake/impliedP`.
  Positive edge = house thinks vol is higher → pays less → positive EV for us.
  Default `dryRunEdge` 0.03 reproduces the honest small-negative-EV reality, so a
  default dry-run run skips most blocks — lower `minEv` (or use a negative edge)
  to see it trade.
- **NOTOUCH duration in the quote callback.** `makeBandQuote` must submit NOTOUCH
  in minutes (`duration_unit: 'm'`), matching `openLeg` — seconds returns
  `"Trading is not offered for this duration"`.

## Early exits & staggered sizing (Phase 2)

Phase 2 turns "hit a fixed TP" into "lock in a move" and scales each leg by how
much the quoted price disagrees with our model. `engine/exitLogic.ts` is pure and
unit-tested; `pairTrader.ts` wires it in.

- **Three exits, fixed precedence.** On every contract update `maybeTriggerTp`
  evaluates TP (combined P/L ≥ `blockTp`), then SL (≤ `−blockSl`), then trail
  (retraced `blockTrail` below the intrabar peak). All three are per-block,
  soft-config (hot-swappable mid-run), and `0` = disabled. `blockSl` and
  `blockTrail` default to 0, so default behaviour is unchanged.
- **Trail arms at half the TP.** `trailArmAt = blockTp × DEFAULT_TRAIL_ARM_FRACTION`
  (0.5). The peak must clear that before a retrace can trigger — a pair that
  never went deep into profit doesn't get trail-sold.
- **`tpTriggered`/`selling` guard is unchanged.** Once any exit fires, the pair is
  closed for the block; the exit reason prefixes the sell line (`pair P/L … >= tp`,
  `<= -sl`, or `retraced X from peak +Y`). `body.tsx` renders all three.
- **Edge-scaled stake (`--ev-stagger`, default off).** Each leg's stake becomes
  `base × clamp(1 + 2·edge, 0.5, 2)` where `edge = trueP − impliedP`. EV mode
  passes the selector's per-leg edge straight through (`openPair.edges`) so no
  extra proposal is needed; legacy mode derives the edge from one proposal per
  leg in `resolveLiveStake`. The trade-open line appends `×<ratio>` when it
  deviates from 1.00.
- **Dry-run mark-to-market.** Live P/L comes from the server stream; dry-run has
  none, so each synthetic tick calls `PairTrader.markToMarket` which re-prices
  open legs via `currentWinProb` (reflection-principle win rate at the current
  distance vs remaining time) → `markToMarketProfit`, then re-runs the exits.
  This is what makes TP/SL/trail observable in `--dry-run`.

## Survival & measurement (Phase 3)

Phase 3 adds the tools that turn a session into data: a durable equity ledger,
circuit-breakers that stop the bot when it's bleeding, and a replay backtester
that measures the strategy honestly against history. All three default off.

- **Append-only ledger (`--ledger <path>`).** One CSV row per realised block:
  `at, block, mode, source, days_used, ev_k, open, pred_h, pred_l, exit,
  pnl_up, pnl_dn, pnl_block, session_pnl`. `engine/ledger.ts` creates the file
  + header on first write (mkdir only when the path has a real dir — `mkdirSync('.')`
  throws EEXIST on Windows) and is append-only; reading happens once at boot via
  `seedDayFromLedger` to seed today's P&L into the session so the daily-loss
  breaker survives restarts. `ledgerDayPnl`/`utcDayKey` are UTC-based.
- **Circuit-breakers.** `evaluateSessionGuards` runs after session TP/SL:
  `maxConsecutiveLosses` halts on a losing streak, `dailyLossCap` halts when
  `session.dayProfit <= -cap`. Both are soft-config. `dayProfit` is seeded from
  the ledger at boot AND `evaluateSessionGuards` is called at `start()` so a day
  already blown before launch halts before the first block, not after it.
- **Replay backtester (`--backtest`).** `engine/backtest.ts` walks every
  UTC-aligned block with a realised candle, runs the same band formation as the
  live bot against only the history available at block start (no future peeking),
  resolves each leg against the block's own high/low/close, and aggregates
  win rate, P&L, expectancy, profit factor, max drawdown, longest losing streak
  and (when a model existed) per-leg EV. Candles come from `--csv` (5-col OHLC)
  or live Deriv via `--token`. `cli/backtest.ts` is the runner; `--backtest-edge`
  models a house that mis-prices vol relative to recent realized vol (0 = fair
  house → EV≈0 and coin-flip win rate is the honest baseline — see Phase 4 for
  why the house's vol is now recent-realized). Intrabar early exits (TP/SL/trail)
  are NOT modelled — block-granularity history can only show the ride-to-expiry
  outcome, which is the baseline those exits are meant to protect.
- **`selectBand` takes `durationSec`.** Replay has no wall-clock "now", so the
  backtester passes the full block length; live mode still defaults to the
  time left in the block.

## Volatility regime detection (Phase 4)

The win-rate model calibrates σ from a long same-TOD mean excursion; volatility
is not stationary. During a vol spike the house (pricing from live recent vol)
quotes cheap stay-in-range payouts while our stale low-σ model computes large
positive EV — phantom edge that trades into losses. Phase 4 measures recent
realized vol and blends it into the model so trueP tracks current vol.
`engine/regime.ts` is the pure core; default off (`--regime-blend 0` = identity).

- **Blend at the mean level.** `blendMeans(sameTodUp, sameTodDn, recent, blend)`
  interpolates `sameTod + blend·(recent − sameTod)` per side. Because
  `winRateModelFromMeans` derives `σ = mean/√(2T/π)` — a fixed linear rescaling —
  blending the mean is exactly equivalent to blending σ. Both `predictRange` and
  `estimateWinRates` blend BEFORE the model is built, and return the blended
  means, so the caller's `winRateModelFromMeans(...)` inherits it for free.
- **`recentExcursions` measures completed block-windows, no future peek.**
  Mean up/dn excursion per window [wStart, wStart+blockSec) with `wStart <
  blockStart` — the SAME (max high − first open) / (first open − min low)
  definition as the same-TOD loop, so it's comparable at any candle granularity.
  `count` = windows with data (gaps don't pollute the mean); null → skip blend.
- **The backtest house prices from RECENT vol.** `backtestBlock` computes the
  house's `σ·√T = E[max]·√(π/2)` from recent realized vol and passes THAT to
  `simulateQuote` — regardless of how much our model blends. This is what makes
  the phantom-EV gap *measurable*: with `--backtest-edge 0`, blend 0 shows
  phantom EV (house vol >> stale model), blend 1 shows EV ≡ 0 (model == house).
  On stationary history recent == same-TOD, so results are numerically identical
  to Phase 3. `--backtest-edge` therefore means "house vol premium relative to
  **recent realized vol**" — update the docs' fair-house wording accordingly.
- **ATR branch untouched.** ATR is already a recent-vol measure; regime's job is
  to make the historical same-TOD branch track current vol. `mode='atr'` ignores
  `regime` entirely. (The roadmap's "regime to gate historical vs ATR in hybrid"
  is a DIFFERENT feature and remains open.)
- **Hard config.** `regimeBars`/`regimeBlend` are prediction-model fields — like
  `rangeMode`/`lookbackDays`, changing them auto-stops the bot (`patchConfig`
  already rejects non-soft fields).

## Invariants (don't break these)

- **Prediction is locked per block.** Once `predictRange` has run at block-start, `predictedHigh` / `predictedLow` must not change intrabar. Guarantees non-repaint. Don't call it more than once per block from the Trader. (In EV mode, `selectBand` replaces `predictRange` but the same lock applies — the chosen K is fixed for the block.)
- **EV mode is off by default.** `--ev-mode` must be explicit. The legacy fixed-K path stays the default so behaviour is unchanged unless opted in.
- **EV floor gates trading.** In EV mode a block is only opened when `bestEV ≥ minEv`. The selector never trades a negative-EV block — that's the whole point.
- **One pair per block.** `pairTrader` opens the two legs in parallel via `Promise.allSettled`; never a second pair before the current block ends.
- **Both modes are stay-in-range.** `higher-lower` = LOWER @ predH + HIGHER @ predL (exit-spot only). `no-touch` = NOTOUCH @ predH + NOTOUCH @ predL (no intrabar touch). Don't confuse with a breakout strategy.
- **Barrier sanity**: upper leg is skipped if `predictedHigh <= spot`; lower leg is skipped if `predictedLow >= spot`. The barrier must be on the right side of current spot for the bet to be meaningful (regardless of mode).
- **Fresh blocks only.** `Trader.start()` does NOT fire `onBlockStart` for the in-progress block — it waits for the next UTC-aligned boundary. This aligns the contract duration 1:1 with the block and keeps the prediction fresh.
- **NOTOUCH duration resolution**: NOTOUCH is submitted in minutes, so the pair skips any block where the full `blockMinutes` isn't available. Paired with the fresh-block-only rule, this never triggers in practice.
- **UTC-midnight grid**: `BlockClock` floors `nowSec / blockSec`, i.e. blocks are anchored to UTC 00:00.
- **Stop is one-shot.** `Trader.stop()` tears down the WebSocket (`intentionalClose = true`) — the same instance can't restart. `commands.ts::ensureTrader` creates a fresh Trader after each `/stop`.
- **Soft vs hard config.** Soft fields (`stake`, `blockTp`, `blockSl`, `blockTrail`, `evStagger`, `sessionTp`, `sessionSl`, `currency`) are hot-swap safe via `Trader.patchConfig`. Hard fields (`mode`, `rangeMode`, `symbol`, `blockMinutes`, `lookbackDays`, `atrBars`, `rangeK`, auth) auto-stop on change — user must `/start` to resume.
- **Exits re-evaluate every contract update.** `PairTrader.maybeTriggerTp` runs TP, SL, then trail on each P/L update, in that precedence order. The trail state (intrabar peak + armed flag) resets every block; once a leg resolves, only the still-open legs are sold candidates.
- **Dry-run marks to market per tick.** Live P/L comes from the proposal_open_contract stream; dry-run has no server, so `PairTrader.markToMarket` re-prices each open leg each synthetic tick and feeds the same exit evaluator. This is what makes TP/SL/trail observable offline. Don't remove it or dry-run exits silently stop firing.
- **EV mode passes its edges to the buy.** `Trader.onBlockStart` sends the selector's per-leg edge (`trueP − impliedP`) in `openPair.edges` so `evStagger` sizing needs no second proposal. Legacy mode (no `edges`) derives the edge from one extra proposal per leg in `resolveLiveStake`. Stagger is off by default.
- **Backtest never peeks.** `backtestBlock` runs the band formation against only the candles with `epoch < blockStart`; the block's own candles are used solely for outcomes. The `durationSec` passed to `selectBand` is the full block in replay (no live "now").
- **Backtest outcome rules mirror live.** higher-lower resolves at the exit spot (close); no-touch resolves on the full high/low (any touch loses). Same contract-type semantics as `pairTrader.realiseAtBlockEnd`.
- **Ledger writes are append-only and guarded.** `appendLedgerRow` must never rewrite history; `recordLedger` in the Trader wraps it in try/catch and downgrades failures to a warn. `seedDayFromLedger` runs exactly once per Trader instance.

## Config & env

Runtime defaults live in `src/constants/api.ts`. `.env` (auto-loaded by Bun) can set:
- Auth / account: `DERIV_TOKEN`, `DERIV_APP_ID`, `DERIV_ACCOUNT_ID`, `HILO_PREFER` (demo|real)
- Market: `HILO_SYMBOL`, `HILO_STAKE`, `HILO_CURRENCY`
- Block grid: `HILO_BLOCK_MINUTES`, `HILO_BLOCK_TP`, `HILO_BLOCK_SL`, `HILO_BLOCK_TRAIL`, `HILO_SESSION_TP`, `HILO_SESSION_SL`
- Trade primitive: `HILO_TRADE_MODE` (higher-lower|no-touch)
- Prediction: `HILO_RANGE_MODE`, `HILO_LOOKBACK_DAYS`, `HILO_ATR_BARS`, `HILO_RANGE_K`
- Volatility regime (Phase 4): `HILO_REGIME_BARS`, `HILO_REGIME_BLEND` (0 = off)
- EV band selection: `HILO_EV_MODE` (1|true), `HILO_K_CANDIDATES` (comma K list), `HILO_MIN_EV`, `HILO_DRY_RUN_EDGE`, `HILO_EV_STAGGER` (1|true)
- Phase 3: `HILO_LEDGER`, `HILO_MAX_LOSSES`, `HILO_DAILY_LOSS_CAP`, `HILO_BACKTEST_EDGE`

Precedence: **CLI flag > env var > built-in default**.

## TUI conventions

- **Single outer padding**. `App.tsx` holds the only `paddingX={1} paddingTop={1}`; every other panel renders flush. Don't re-add per-child `paddingX` — it shifts elements out of alignment.
- **Transcript rows truncate, never wrap.** `transcript/Row.tsx` uses `<Text wrap="truncate-end">` — if you add a new log kind, preserve this wrapper so timestamps can't split across lines.
- **Leg labels always carry an arrow.** `↑` = upper/predH leg, `↓` = lower/predL leg. The text before the arrow is the actual Deriv contract type (`LOWER↑`, `HIGHER↓`, `NOTOUCH↑`, `NOTOUCH↓`). Transcript regexes accept the arrow-less legacy form too.
- **Commands read/write through the store.** Never mutate Trader internals from a command handler; go through `patchCfg` or `trader.patchConfig`. That's the only way the TUI sees the change.
- **Colour palette in `src/ui/theme.ts`**. Gold = block / trade-open, upBright/downBright = wins/losses, violet = barrier & no-touch mode, ice = duration, accent (cyan) = chrome & higher-lower mode, accent2 (magentaBright) = sell. New UI text should pick from the theme — don't introduce raw hex elsewhere.
- **Prompt alignment**. The input row renders `❯ {value}`, so the typed `/` lands at column 2 of the Prompt container. The autocomplete menu uses a 2-char indicator (`› ` / `  `) then `/{name}` so the menu's `/` lines up under the typed `/`. Changing indicator width breaks alignment.
- **SelectMenu gating.** `App.tsx` renders `<SelectMenu>` instead of `<Prompt>` when `menuStack.length > 0` — both install `useInput`, never render them simultaneously. Push menus via `useStore.getState().pushMenu({title, items})`.

## Testing

- `bun run typecheck` — must stay clean; CI-style gate before any commit.
- `bun src/index.tsx --help` — sanity-check the CLI surface.
- `bun src/index.tsx --dry-run --block-minutes 1 --block-tp 3` — end-to-end smoke in a wide terminal. Synthetic candles, simulated buys/sells, no network. Note: `/start` now waits for the next UTC-aligned 1-minute boundary (up to 60s), then opens a pair. Block rolls over every minute thereafter. Dry-run emits a ~1Hz synthetic tick stream so the spot moves and block closes (and NOTOUCH intrabar touches) are realistic.
- `bun src/index.tsx --dry-run --block-minutes 1 --block-tp 3 --ev-mode` — EV selector smoke. With the default `minEv=0.3` the honest small-negative-EV should print `EV scan: …` then skip each block (`warn … best combined EV below 0.30 — skipping`). To see it trade: `--ev-mode --min-ev 0.1 --dry-run-edge 0.2` (bigger simulated edge → reachable EV).
- `bun src/index.tsx --dry-run --block-minutes 1 --block-tp 1.5 --block-sl 1.2 --block-trail 0.5 --stake 5` — Phase 2 exits smoke. The dry-run tick loop marks the pair to market, so a TP sell should appear mid-block (`pair P/L … >= tp …`). Trail/SL depend on the synthetic path; their branches are pinned by the unit tests.
- `bun src/index.tsx --dry-run --block-minutes 1 --block-tp 3 --stake 5 --no-ui --ledger .tmp.csv` — Phase 3 ledger smoke. After ~2 blocks the CSV gets a header + one row per block, and a second launch prints `ledger: N rows · today ±X (YYYY-MM-DD)`.
- `bun src/index.tsx --backtest --csv <5-col OHLC.csv> --block-minutes 3` — Phase 3 backtest smoke (no auth). Expect a win-rate / P&L / expectancy summary; with a fair house and `--ev-mode` most blocks skip (`best EV … below floor`).
- `bun scripts/make_regime_csv.ts 42 > regime.csv` then the Phase 4 regime smokes — EV mode over that 2-regime CSV proves the phantom-EV thesis: blend 0 (default) trades thousands of blocks on `avg EV > 0` with negative realised P&L; `--regime-blend 1` skips everything (`best EV … below floor`); `--regime-blend 0.7` trades only at a low `--min-ev` (residual gap). Legacy `--range-mode historical --regime-blend 1` widens the band on high-vol days and logs `avg EV −0.00`. Add `--backtest-edge 0.05` to see blend 0 trade AND realise a loss, blend 1 stay flat.
- `bun test` — unit harness. Fixtures in `engine/rangePredictor.test.ts` assert deterministic outputs; `constants/api.test.ts` pins the allowed-block-size guard; `state/store.test.ts` covers halt/reset/session accounting; `engine/bandSelector.test.ts` covers the EV selector (win-rate model, K grid, skip-below-floor, spot-anchoring) with deterministic same-TOD fixtures and a controlled house-quote callback; `engine/exitLogic.test.ts` pins the TP/SL/trail decisions, precedence, edge-scaled stake clamps, and the dry-run mark-to-market helpers; `engine/backtest.test.ts` pins leg resolution (exit-spot vs no-touch), EV skip/trade, aggregation, and the Phase 4 house-vol split; `engine/ledger.test.ts` pins CSV round-trip, file creation, and UTC day P&L; `engine/regime.test.ts` pins `recentExcursions` (window aggregation, no-peek, warmup, most-recent bias), `blendMeans` (identity/blend/guards/ratio clamps), and `regimeFromConfig` (default-off gate). The phantom-EV thesis is pinned in `bandSelector.test.ts` (blend 0 → EV > 0, blend 1 → EV ≈ 0 against a recent-vol-quoting house) and end-to-end in `backtest.test.ts` (spike fixture: blend 0 trades, blend 1 skips, legacy band widens).

## Ancestry

Heavy inspiration from `G:\Dineth\deriv\kairos-trade` (same author, different strategy). Parts reused verbatim: OAuth+OTP auth flow, session-rollover / reactive-reconnect lifecycle in the WS client, Zustand store pattern, Ink transcript row layout, nested SelectMenu pattern, Prompt/CommandMenu autocomplete. What was intentionally dropped: martingale, sniper, rotation, fuzz, adaptive-duration — HiLo-Fast's strategy locks both legs for the whole block and has no use for those overlays.

The range predictor started life as an MT5 chart indicator (vertical block lines + historical-same-TOD predicted high/low + ATR fallback). It's been fully ported to `engine/rangePredictor.ts`; the MT5 `.mq5` source is no longer in the repo.
