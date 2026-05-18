# Stat-Arb Research Dashboard Holistic Review

Date: 2026-05-19

Scope reviewed:

- `services/stat-arb-bot`
- `apps/backtest-web`
- `packages/market-core`
- `packages/db`

Scope intentionally excluded:

- Live transaction construction
- Wallet custody
- Real trading bot execution
- Order submission infrastructure

This supersedes the older `docs/stat-arb-bot-review-notes.md` as a dashboard/research handoff. Several defects in that older note have already been fixed: Pyth freshness is now recorded and enforced, Lazer uses multiple endpoints, successful Jupiter quote metadata is stored, the scheduler catches async failures, pair RPS budgeting exists, and paper PnL is now spot-inventory based.

## Executive Verdict

The current implementation is a decent data-collection and monitoring foundation, but it is not yet a competitive stat-arb research dashboard.

The service collects the right primitive observations: Pyth reference price, executable Jupiter buy/sell quotes, size-specific effective token prices, net edge, route metadata, freshness, latency, quality status, market regime, and spot-only paper signals. That is the correct direction.

The dashboard, however, still does not answer the core research question clearly:

> For this onchain/underlying pair, under realistic Solana liquidity, latency, market-session, and cost assumptions, is there repeatable executable edge worth studying further?

Canonical orientation must be **onchain asset / underlying reference**, not the reverse. Pair labels, ratio labels, chart legends, tables, and exported DTO names should read like `WBTC/BTC`, `AAPLx/AAPL`, `NVDAx/NVDA`, or `XAUt0/XAU`. The canonical ratio is:

```text
onchain_underlying_ratio = executable_onchain_price_usd / underlying_reference_price_usd
```

Interpretation:

- `< 1.0000`: onchain asset is cheap versus the underlying.
- `> 1.0000`: onchain asset is rich versus the underlying.

Internal buy/sell edge helpers can use inverse formulas for convenience, but the dashboard and research language should never flip the pair orientation.

Today the UI mostly exposes tables and recent metrics. A researcher still has to mentally combine quote quality, basis age, market regime, opposite-side route availability, cost assumptions, liquidity curve, and replay output. That is why it feels clunky and hard to interpret.

The right next step is not to tune thresholds. The right next step is to overhaul the dashboard into a decision-oriented research cockpit while iterating on the collector.

## Current System Shape

The collector is organized well:

- `PythStream` streams Lazer prices from all public endpoints and deduplicates updates.
- `QuoteScheduler` admits quote work based on time, price move, and Jupiter RPS budget.
- `JupiterClient` calls `/swap/v2/order`.
- `recordQuote` stores compact quote metadata and derived basis observations.
- `SignalEngine` models spot-only paper inventory: buy tokenized asset first, sell only to close.
- `api-server` exposes dashboard, health, and pair detail DTOs.
- `market-core` owns reusable math: edge, cost model, quote quality, readiness, hold-horizon replay, two-size replay, profitability summary.
- `backtest-web` consumes the bot API and renders overview and pair-detail pages.

This is a sound separation of concerns for a V1 research stack.

## What Is Working

These pieces should be kept and iterated:

- **Executable quote basis:** The dashboard uses Jupiter executable quotes rather than only comparing oracle marks. That is essential for Solana.
- **Pyth freshness metadata:** `basis_observations` now records stream timestamp, feed update timestamp, freshness lag, confidence, and market session.
- **Quality gate:** `QuoteQualityStatus` is a good primitive for deciding which rows are research-eligible.
- **Pair readiness matrix:** This is useful as a tradability checklist, especially route existence, quote success rate, latency samples, and sample count.
- **Spot-only paper model:** The paper signal model correctly avoids synthetic shorts. This is non-negotiable on Solana unless a borrow venue is explicitly integrated later.
- **Two active sizes:** `$250` and `$1,000` are reasonable initial probes while Jupiter RPS and liquidity are unknown.
- **Market-regime labeling:** Separating US equity, metal, and crypto regimes is the right idea.
- **Bot read API:** Keeping the dashboard off direct DB access is the right deployment boundary.

## Main Problem

The implementation collects research ingredients but does not produce a research conclusion.

The dashboard should make the first screen for each pair say something like:

- `NOT READY`: sell route missing, token mint not verified, or too many stale rows.
- `COLLECT MORE`: tradable routes exist but sample count is too small.
- `NO EDGE`: enough clean samples, but edge does not survive costs.
- `PAPER EDGE`: clean repeated edge exists under conservative costs, but needs longer out-of-sample data.
- `CANDIDATE`: enough clean data, executable routes, stable liquidity, positive replay, and manageable drawdown.

Today the user sees best ratios, a quote table, readiness rows, replay rows, quality distribution, regime summary, and paper PnL. Those are useful, but the system never combines them into a verdict. It also does not enforce a single onchain/underlying naming convention across the research surface.

## Solana-Specific Pushback

Do not let the dashboard imply an executable arb that Solana constraints do not support.

- A `sell_tokenized` edge is not executable unless the strategy already owns tokenized spot inventory. There is no implicit short.
- Pairs must be displayed as onchain/underlying, because the Solana leg is the executable asset. Reversing the pair to underlying/onchain hides what the bot can actually buy or sell.
- Token decimals in config are not the same as on-chain validation. A dashboard should not call decimals "verified" until it fetches and stores the mint account, token program, and relevant Token-2022 extensions.
- Fixed bps costs are insufficient for small Solana trades. Priority fees, tips, failed transaction costs, ATA creation, and rent-related setup costs often behave like fixed USD/SOL costs, not pure bps.
- Tokenized equities and metals are not 24/7 live-reference arbs. Outside the underlying market session, the dashboard must label observations as "reference closed" or "stale reference basis", not live executable stat arb.
- Jupiter route availability is not route stability. A pair can have a route and still be a bad execution candidate if the router/maker flips, price impact jumps, or quote expiry is too short.

## Overhaul vs Iteration

### Needs Overhaul

| Area | Why It Needs Overhaul | Primary Files |
| --- | --- | --- |
| Research verdict model | The dashboard has no single pair-level decision framework. | `packages/market-core/src`, `services/stat-arb-bot/src/api-server.ts`, `apps/backtest-web/src/app/pairs/[id]/page.tsx` |
| Pair and ratio orientation | Labels must be canonicalized to onchain/underlying so every ratio and conclusion names the executable Solana asset first. | `packages/market-core/src/api-dto.ts`, `services/stat-arb-bot/src/api-server.ts`, `apps/backtest-web/src/components/PairCard.tsx`, `apps/backtest-web/src/app/pairs/[id]/page.tsx` |
| Best edge selection | Overview and top cards can highlight rows without first requiring live eligibility and synchronized opposite-side quotes. | `services/stat-arb-bot/src/api-server.ts`, `apps/backtest-web/src/components/PairCard.tsx` |
| Statistical analysis | There is no rolling z-score, edge distribution, mean-reversion half-life, stationarity check, or out-of-sample validation. | `packages/market-core/src` |
| Backtest/replay model | Current replays are useful diagnostics but not enough to support profitability claims. | `packages/market-core/src/two-size-backtest.ts`, `packages/market-core/src/hold-horizon.ts` |
| Cost model | Current net edge mixes environment-level assumptions and pair-level thresholds in a way that is hard to interpret. | `packages/market-core/src/cost-model.ts`, `services/stat-arb-bot/src/basis-recorder.ts` |
| Pair taxonomy | Bridged crypto, tokenized equity, and tokenized metal need different research rules. | `packages/market-core/src/pair-config.ts`, `services/stat-arb-bot/src/market-hours.ts` |
| Dashboard information architecture | The pair page is table-heavy and diagnostic-first, not decision-first. | `apps/backtest-web/src/app/pairs/[id]/page.tsx` |

### Needs Iteration

| Area | Iteration Needed | Primary Files |
| --- | --- | --- |
| Quote quality table | Humanize enum labels, make reasons visible on mobile, rename "live rows" to "latest rows" when rows include non-live statuses. | `apps/backtest-web/src/app/pairs/[id]/page.tsx` |
| Pair readiness | Raise sample thresholds, split tradability readiness from profitability readiness, and explain failed checks in plain language. | `packages/market-core/src/pair-readiness.ts` |
| Time regimes | Keep current regime labels but add holidays, maintenance, and reference-closed handling. | `services/stat-arb-bot/src/market-hours.ts` |
| RPS budget | Keep admission control, but expose budget pressure and rejected pair configs in the dashboard. | `packages/market-core/src/rps-budget.ts`, `services/stat-arb-bot/src/index.ts` |
| API windows | Keep current DTOs, but add `window=1d|7d|30d` and server-side aggregation. | `services/stat-arb-bot/src/api-server.ts`, `packages/db/src/basis.ts` |
| UI polish | Keep HIG style, but add filters, clearer hierarchy, compact charts, and human-readable labels. | `apps/backtest-web` |

## Parameter Review

### Quote Sizes

Current active sizes are hardcoded to `$250` and `$1,000` via `ACTIVE_QUOTE_SIZES_USD`.

This is acceptable for initial data collection. It is not enough for competitive liquidity research.

Next iteration:

- Keep `$250` and `$1,000` as the default low-load probes.
- Add a per-pair size ladder once RPS budget allows it.
- Use the ladder to infer liquidity slope, not just latest edge.
- Display "marginal edge" only when quotes are synchronized in time.

Do not add a wide size ladder blindly. Jupiter RPS is the bottleneck, and Solana quote routes can degrade quickly for thin tokenized assets.

### Quote Cadence

`quoteIntervalMs` plus `minPriceMoveBps` is a reasonable scheduler primitive.

Problems:

- The dashboard does not show how often each side/size is actually quoted.
- Missed quote opportunities due to RPS exhaustion are not visible as first-class research data.
- Single-pair settings do not tell the user whether global RPS pressure is starving some pairs.

Add:

- `scheduled_quotes`
- `admitted_quotes`
- `dropped_due_to_rps`
- `dropped_due_to_stale_pyth`
- `dropped_due_to_market_session`
- per pair/side/size effective quote frequency

### Cost Assumptions

Current net edge:

```text
net_edge_bps = gross_edge_bps
  - slippage_buffer_bps
  - landing_cost_bps
  - failure_buffer_bps
  - min_profit_bps
```

Signals then require:

```text
net_edge_bps >= pair.minNetEdgeBps
```

This is too opaque. With defaults, `MIN_PROFIT_BPS=20` and `pair.minNetEdgeBps=20` are effectively two separate profit hurdles. That may be intentional, but the dashboard does not show the gross hurdle decomposition.

Required change:

- Rename fields so the economics are explicit:
  - `gross_edge_bps`
  - `estimated_execution_cost_bps`
  - `required_profit_bps`
  - `entry_threshold_bps`
  - `edge_after_cost_bps`
- Show a cost waterfall in the pair detail page.
- Add sensitivity scenarios:
  - base costs
  - doubled costs
  - doubled latency
  - worse slippage
  - route failure haircut
- Treat fixed Solana fees separately from bps costs, especially at `$250`.

### Quality Thresholds

Current defaults are a useful start:

- Pyth freshness
- quote latency
- basis age
- price impact
- Pyth confidence
- allowed routers
- allowed market sessions

Needed changes:

- Thresholds must be visible per pair.
- Threshold failures must be summarized as "why this pair is not research-ready."
- Defaults must vary by pair class. BTC/WBTC and tokenized NVDA should not share the same freshness/session model.
- `CRYPTO_HIGH_VOL_MOVE_BPS` should be replaced by rolling realized volatility. A single tick move from the previous tick is not a stable volatility regime.

## Analysis Method Review

### Edge Calculation And Ratio Orientation

The primitive edge formulas are reasonable:

- buy edge: reference over executable buy price
- sell edge: executable sell price over reference
- net edge: gross edge minus costs

Keep these primitives internally, but add a canonical displayed basis:

```text
display_ratio = executable_onchain_price_usd / underlying_reference_price_usd
display_basis_bps = (display_ratio - 1) * 10000
```

Dashboard interpretation:

- negative `display_basis_bps`: onchain asset is cheap, potential buy-tokenized setup
- positive `display_basis_bps`: onchain asset is rich, potential sell-tokenized setup only if inventory exists

This avoids the current ambiguity where some wording talks as if the pair is underlying/tokenized while some UI ratio math already behaves like tokenized/underlying.

But the dashboard should stop presenting raw "best buy" or "best sell" as a conclusion. Edge only matters when:

- the observation is `LIVE_ELIGIBLE`
- market session is valid
- quote and reference are fresh
- opposite-side route exists now, not merely sometime in the past
- route/maker is stable enough
- price impact is inside the threshold
- cost scenario is explicit

### Pair Readiness

`buildPairReadinessMatrix` is a good tradability checklist. It should not be treated as profitability readiness.

Split it into two layers:

1. **Tradability readiness:** feeds, routes, decimals, quote success rate, latency, market session.
2. **Research readiness:** sample size, live share, clean window length, route stability, synchronized entry/exit quote coverage.

### Two-Size Replay

`runTwoSizeBacktestV2` is useful as a simple size diagnostic. It should not drive a trade recommendation yet.

Issues:

- It can leave losing positions open without marking unrealized loss in the headline PnL.
- It only needs a sell route to have been seen before, not a current sell quote within a strict max age.
- `edgeNext750Bps` compares latest `$250` and `$1,000` buys that may not be synchronized.
- It has no capital, inventory, cooldown, or daily max loss model.

Rename the UI section from `$250 vs $1000 replay` to `Size probe diagnostic` until a stronger replay engine exists.

### Hold Horizon Replay

`runHoldHorizonReplay` is a better research primitive because it tests exits over fixed max-hold horizons.

Keep it, but do not let it be the sole profitability proof.

Required improvements:

- Report unrealized PnL for open positions.
- Require entry and exit route observations within a configurable max age.
- Track max adverse excursion and max favorable excursion.
- Track time-to-profit distribution.
- Track opportunity half-life: how long positive edge survives before disappearing.
- Add walk-forward splits instead of only replaying one 24h window.
- Add cost-sensitivity rows.

### Missing Statistical Layer

A competitive stat-arb dashboard needs a statistical layer that is currently absent.

This layer must test mean reversion toward the pair's own fair ratio, not blindly toward `1.0000`.

For every onchain/underlying pair, compute:

```text
ratio_t = executable_onchain_price_t / underlying_reference_price_t
fair_ratio_t = rolling or regime-specific estimate of the pair's equilibrium ratio
deviation_bps_t = (ratio_t / fair_ratio_t - 1) * 10000
```

`1.0000` is only the starting prior for same-underlying assets. The estimated fair ratio may persistently differ from one because of liquidity, bridge risk, issuer risk, redemption friction, market-session effects, route/maker structure, or token-specific constraints. The dashboard should trade/test deviations from fair ratio, not the entire discount or premium versus `1.0000`.

The expected empirical distribution is not normal. Expect:

- tight center around the estimated fair ratio
- fat tails during liquidity shocks, stale-reference periods, route failures, and opens/closes
- skew, because cheap-onchain and rich-onchain setups have different liquidity and execution constraints
- regime dependence across regular session, after-hours, maintenance windows, crypto high-vol periods, and route/maker states
- pair-class dependence: bridged crypto should usually be tighter than tokenized equities/metals, while thin onchain assets may have noisy, route-dependent tails

Implement these first:

- rolling mean, median, and robust median/MAD of onchain/underlying ratio
- pair-specific fair ratio by window and regime
- deviation from fair ratio in bps
- standard z-score and robust z-score of deviation from fair ratio
- distribution quantiles: p1, p5, p10, p50, p90, p95, p99
- tail frequency and tail persistence beyond configurable thresholds
- skew/asymmetry between onchain-cheap and onchain-rich deviations
- rolling volatility of deviation/basis
- mean-reversion half-life using a simple lagged regression
- opportunity frequency above threshold
- average time deviation remains above threshold
- return distribution by hold horizon
- out-of-sample window comparison
- regime-specific distributions and fair ratios
- cost-sensitivity overlays on the distribution, so the UI can show which parts of the tail are actually tradable

Cointegration is optional at this stage. For tokenized or bridged versions of the same underlying, the expected relationship is usually near 1:1, so a ratio/z-score and mean-reversion framework gives more immediate value. Add cointegration later if the dashboard starts comparing non-identical instruments.

## Dashboard UX Review

The dashboard should be reorganized around decisions.

### Current UX Problem

The pair detail page shows many diagnostics in this order:

- best buy/sell/spread cards
- quote surface
- hold horizon replay
- pair readiness
- two-size replay
- quality distribution
- time regime comparison
- paper PnL
- signal history
- data quality

This is too much work for the user. The most important question, "should I keep researching this pair?", is buried.

### Target Pair Page Structure

1. **Research Verdict**
   - status
   - confidence
   - top blockers
   - next action
   - clean sample window
   - cost scenario used

2. **Current Opportunity**
   - live-eligible onchain/underlying basis only
   - synchronized quote age
   - current opposite-side exit availability
   - route/maker
   - price impact
   - "not executable" reason when relevant

3. **Feasibility**
   - tradability readiness
   - token mint validation
   - route success rate
   - quote frequency
   - RPS pressure
   - market-session validity

4. **Profitability Evidence**
   - hold horizon replay
   - paper PnL with unrealized PnL
   - drawdown
   - win rate
   - average hold
   - cost sensitivity
   - out-of-sample comparison

5. **Statistical Evidence**
   - ratio/edge z-score
   - edge distribution
   - mean-reversion half-life
   - opportunity frequency
   - regime comparison

6. **Raw Diagnostics**
   - latest quote surface
   - quality distribution
   - route distribution
   - signal history
   - heartbeat and endpoint health

### Overview Page Changes

The home page should not just show tracked pairs. It should rank pairs by research usefulness:

- `Current live opportunity`
- `Best clean 24h replay`
- `Most data-ready`
- `Needs attention`
- `Collecting data`
- `Rejected`

Every card should show:

- verdict
- clean live sample count
- live share
- best live onchain/underlying basis
- current quote age
- main blocker
- pair class

Do not show a green value for a stale or invalid row.

## Required Data/API Extensions

### Add Research Verdict DTO

Create `packages/market-core/src/research-verdict.ts`.

Suggested shape:

```ts
export type PairResearchVerdictStatus =
  | "NOT_READY"
  | "COLLECT_MORE"
  | "NO_EDGE"
  | "PAPER_EDGE"
  | "CANDIDATE";

export type PairResearchVerdict = {
  status: PairResearchVerdictStatus;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  blockers: Array<{ code: string; detail: string }>;
  positives: Array<{ code: string; detail: string }>;
  cleanSampleCount: number;
  cleanWindowMs: number;
  costScenarioName: string;
  recommendedNextAction: string;
};
```

Inputs should include:

- pair config
- pair readiness matrix
- quality distribution
- hold horizon replay
- statistical summary
- quote route stability
- token validation state

### Add Statistical Summary DTO

Create `packages/market-core/src/stat-summary.ts`.

Suggested shape:

```ts
export type PairStatSummary = {
  windowMs: number;
  side: "buy_tokenized" | "sell_tokenized";
  sizeUsd: number;
  liveSampleCount: number;
  fairRatio: number | null;
  currentRatio: number | null;
  currentDeviationBps: number | null;
  meanRatio: number | null;
  medianRatio: number | null;
  ratioMad: number | null;
  meanDeviationBps: number | null;
  medianDeviationBps: number | null;
  deviationQuantilesBps: {
    p01: number | null;
    p05: number | null;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
  };
  currentZScore: number | null;
  robustZScore: number | null;
  basisVolBps: number | null;
  skewBps: number | null;
  cheapTailCount: number;
  richTailCount: number;
  halfLifeSeconds: number | null;
  opportunityCount: number;
  avgOpportunityDurationSeconds: number | null;
  regimeBreakdown: Array<{
    regime: string;
    fairRatio: number | null;
    liveSampleCount: number;
    medianDeviationBps: number | null;
    p05DeviationBps: number | null;
    p95DeviationBps: number | null;
  }>;
};
```

### Add Route Stability Summary

Extend DB/API aggregation around `jupiter_quotes`.

Expose:

- router distribution
- route changes per hour
- quote success rate
- p50/p95/p99 request latency
- p50/p95/p99 price impact
- quote expiry distribution if available
- context slot age if available

### Add Token Validation Snapshot

Do not keep pretending config decimals are verification.

Add a table:

```sql
CREATE TABLE token_validation_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_program TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  supply NUMERIC,
  mint_authority TEXT,
  freeze_authority TEXT,
  token_2022_extensions JSONB,
  transfer_fee_bps NUMERIC,
  is_valid BOOLEAN NOT NULL,
  validation_reason TEXT NOT NULL
);
```

The dashboard only needs read-only validation. It does not need live execution.

## Implementation Plan For Another AI Agent

### Phase 1: Make Current Dashboard Quality-Safe

Goal: stop highlighting misleading rows.

Tasks:

- In `services/stat-arb-bot/src/api-server.ts`, update `buildPanel`, `pickBest`, and `pickBestSpread` to prefer `qualityStatus === "LIVE_ELIGIBLE"`.
- Canonicalize pair and ratio display to onchain/underlying. Examples: `WBTC/BTC`, `AAPLx/AAPL`, `XAUt0/XAU`.
- Add DTO fields or helper functions that expose `displayRatio = tokenPriceUsd / basePriceUsd` and `displayBasisBps = (displayRatio - 1) * 10000`.
- If no live row exists, return the best diagnostic row separately as `bestDiagnosticBuy` / `bestDiagnosticSell`, not as the primary opportunity.
- Make `bestSpread` use synchronized buy/sell rows. Require both sides to be live and observed within a configurable max age.
- Rename UI labels:
  - `live rows` -> `latest rows`
  - `Best spread` -> `Round-trip spread`
  - `$250 vs $1000 replay` -> `Size probe diagnostic`
- Humanize enum labels in `apps/backtest-web/src/app/pairs/[id]/page.tsx`.

Acceptance criteria:

- No stale, invalid, or market-session-invalid row can appear as the primary green opportunity.
- Every pair label and ratio shown in the dashboard uses onchain/underlying orientation.
- Negative basis is visually explained as onchain cheap; positive basis is onchain rich.
- The overview card always shows the main reason when no live opportunity exists.
- Tests cover stale rows being excluded from best opportunity selection.

### Phase 2: Add Pair Research Verdict

Goal: each pair page starts with a conclusion.

Tasks:

- Add `research-verdict.ts` to `packages/market-core/src`.
- Add tests in `packages/market-core/tests/research-verdict.test.ts`.
- Extend `PairDetailDto` with `researchVerdict`.
- Build verdict in `services/stat-arb-bot/src/api-server.ts`.
- Render a top-level verdict panel in `apps/backtest-web/src/app/pairs/[id]/page.tsx`.
- Render verdict on `PairCard`.

Acceptance criteria:

- A pair with missing sell route is `NOT_READY`.
- A pair with routes but fewer than required clean samples is `COLLECT_MORE`.
- A pair with clean samples but no cost-adjusted edge is `NO_EDGE`.
- A pair with positive replay but low confidence is `PAPER_EDGE`.
- A pair with enough clean samples, stable routes, positive replay, and acceptable drawdown is `CANDIDATE`.

### Phase 3: Add Statistical Summary

Goal: dashboard shows whether the onchain/underlying ratio is statistically far from the pair's own fair ratio, not just recently large versus `1.0000`.

Tasks:

- Add rolling/aggregate stats in `packages/market-core/src/stat-summary.ts`.
- Compute stats per pair/side/size/window.
- Start with windows `24h`, `7d`, `30d`.
- Use live-eligible observations only by default.
- Estimate pair-specific fair ratio with rolling median as the first implementation.
- Add regime-specific fair ratios.
- Add deviation from fair ratio in bps.
- Add median/MAD robust z-score and standard z-score.
- Add quantiles p1/p5/p10/p50/p90/p95/p99.
- Add skew/asymmetry summary for cheap-onchain versus rich-onchain tails.
- Add tail frequency and persistence above configurable thresholds.
- Add simple mean-reversion half-life estimate.
- Add opportunity count and average duration above threshold.
- Add cost-sensitivity overlays that show which deviation tails survive estimated Solana/Jupiter costs.
- Extend API with `statSummary`.
- Add charts/tables in the pair page.

Acceptance criteria:

- Current edge shows as z-score against its own clean historical distribution.
- Current deviation is measured against `fairRatio`, not only against `1.0000`.
- Dashboard shows the fair ratio used for the conclusion.
- Dashboard shows whether the pair distribution is tight, fat-tailed, skewed, or regime-dependent.
- Dashboard separates onchain-cheap tail and onchain-rich tail behavior.
- Dashboard shows which observed tails remain tradable after base and doubled-cost assumptions.
- Thin sample windows are explicitly labeled low confidence.
- Half-life is hidden or marked unreliable when sample count is insufficient.

### Phase 4: Upgrade Replay Into A Causal Research Backtest

Goal: make profitability claims defensible.

Tasks:

- Create `packages/market-core/src/research-replay.ts`.
- Inputs:
  - live observations
  - max entry/exit quote age
  - cost scenario
  - capital limit
  - one-position-per-pair or configurable inventory limit
  - max hold
  - cooldown
- Require a current opposite-side quote at entry.
- Track realized PnL, unrealized PnL, max adverse excursion, max favorable excursion, drawdown, exposure time, and capital utilization.
- Add cost sensitivity replays.
- Keep `hold-horizon.ts` as a simpler diagnostic or fold it into the new replay.

Acceptance criteria:

- Open losing positions are not invisible in headline PnL.
- No entry uses a future sell route or an old sell route.
- Replay output can explain every entry and exit observation ID.
- Dashboard can compare base, doubled-cost, and worse-latency scenarios.

### Phase 5: Add Pair Class And Market-Session Semantics

Goal: stop treating all assets as the same.

Tasks:

- Extend pair config with explicit `pairClass` or derive it from `base.assetClass` plus token metadata:
  - `BRIDGED_CRYPTO`
  - `TOKENIZED_EQUITY`
  - `TOKENIZED_METAL`
  - `TOKENIZED_COMMODITY`
  - `TOKENIZED_FX`
- Add `referenceStatus`:
  - `LIVE_REFERENCE`
  - `REFERENCE_CLOSED`
  - `REFERENCE_STALE`
  - `REFERENCE_UNCERTAIN`
- For equities, rely on Pyth `marketSession` first and add a holiday calendar later.
- For metals, model daily maintenance and weekends more explicitly.
- Update quality gate so closed-reference rows cannot be live-eligible.

Acceptance criteria:

- Tokenized equity observations outside valid underlying sessions are not labeled live arb.
- Metal maintenance/weekend rows are visibly separated.
- Bridged crypto remains 24/7 but still must pass freshness, route, and liquidity checks.

### Phase 6: Token Validation Panel

Goal: make Solana asset assumptions visible.

Tasks:

- Add token validation snapshot table and DB helpers.
- Use Helius RPC or standard Solana RPC to fetch mint account info.
- Validate:
  - decimals
  - token program
  - mint authority
  - freeze authority
  - transfer fees/extensions
  - token supply where useful
- Add validation status to pair readiness and verdict.
- Render a compact token validation panel on pair detail.

Acceptance criteria:

- `DECIMALS_UNVERIFIED` means actual on-chain mint verification failed or is missing, not merely that config has a number.
- Token-2022 transfer-fee assets are flagged before profitability math trusts quoted amounts.

## Suggested File-Level Work Queue

1. `packages/market-core/src/research-verdict.ts`
2. `packages/market-core/tests/research-verdict.test.ts`
3. `services/stat-arb-bot/src/api-server.ts`
4. `packages/market-core/src/stat-summary.ts`
5. `packages/market-core/tests/stat-summary.test.ts`
6. `packages/market-core/src/research-replay.ts`
7. `packages/market-core/tests/research-replay.test.ts`
8. `packages/db/src/basis.ts`
9. `packages/db/src/quotes.ts`
10. `packages/db/migrations/0005_token_validation_snapshots.sql`
11. `packages/db/src/token-validation.ts`
12. `apps/backtest-web/src/app/pairs/[id]/page.tsx`
13. `apps/backtest-web/src/components/PairCard.tsx`

## What Not To Do

- Do not build live execution into this dashboard pass.
- Do not add more pairs before the dashboard can explain why existing pairs are or are not research candidates.
- Do not label closed-market RWA basis as live arb.
- Do not treat pair readiness as profitability readiness.
- Do not show stale/non-live rows as green opportunities.
- Do not tune `minNetEdgeBps` until cost assumptions and clean sample windows are visible.
- Do not introduce synthetic short assumptions for tokenized assets.

## Final Assessment

This is a good foundation for taking the first steps, but not yet a good foundation for drawing confident profitability conclusions.

The collector is directionally right and should be iterated. The dashboard needs an overhaul. The next agent should focus on turning raw observations into a defensible research verdict, with quality-safe opportunity selection, explicit Solana cost modeling, pair-class-specific market semantics, and statistical evidence that distinguishes repeatable dislocation from one-off stale quote artifacts.
