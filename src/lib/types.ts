/* ─────────────────────────────────────────────────────────────────────
   Sotama automation schema (v2).
   Discriminated unions per trigger/action kind drive both the builder
   editors and the keeper wire format.
   ───────────────────────────────────────────────────────────────────── */

import { PublicKey } from "@solana/web3.js";

export { PublicKey };

/** Where the metadata for a TokenRef came from, surfaced in the UI as a caption. */
export type TokenMetadataSource = "canonical" | "devnet" | "mainnet" | "manual";

export type TokenRef = {
  mint: string;
  symbol: string;
  name: string;
  logo?: string;
  decimals: number;
  metadataSource: TokenMetadataSource;
};

export type AssetClass = "Crypto" | "Equity" | "Commodity" | "FX" | "Metal";

export type AssetRef = {
  /** Provider base symbol, may include region prefix: "SOL", "US.NVDA", "EUR", "XAU" */
  symbol: string;
  /** Ticker only, no pair or region prefix: "SOL", "NVDA", "EUR", "XAU" */
  displaySymbol: string;
  name: string;
  assetClass: AssetClass;
  logo?: string;
  /** Solana SPL mint — only present for on-chain crypto assets */
  mint?: string;
  decimals?: number;
  metadataSource?: TokenMetadataSource;
};

export type QuoteRef =
  | { kind: "usd" }
  | { kind: "asset"; asset: AssetRef };

export type SpecificOrAny<T> =
  | { mode: "specific"; value: T }
  | { mode: "any" };

/** What the keeper should subscribe to for a price-driven trigger.
 *  The keeper's adapter dispatch keys off `kind`; adding a new oracle
 *  is one variant here + one resolver in `oracles.ts` + one keeper
 *  watcher. `mapTriggerToIx` translates `kind` → on-chain `source` byte.
 *
 *  `inverted` (Pyth only): true when the resolved feed quotes the pair
 *  in the opposite direction (e.g. Pyth has FX.USD/SGD but the user
 *  picked SGD with USD quote). Live preview displays `1 / raw_price`,
 *  and `mapTriggerToIx` flips the comparator and inverts the threshold
 *  before save so the on-chain trigger fires when the inverted feed
 *  crosses — keeper never has to know about inversion. */
export type OracleSource =
  | { kind: "pyth"; feedId: string; symbol: string; inverted?: boolean }
  | { kind: "jupiter"; mint: string; symbol: string }
  | { kind: "switchboard_pending"; symbol: string };

/* ── Triggers ──────────────────────────────────────────────────────── */

export type AssetPriceTrigger = {
  kind: "asset_price";
  asset: AssetRef;
  quote: QuoteRef;
  comparator: "above" | "below";
  threshold: number;
  oracle: OracleSource;
};

export type AccountTransferTrigger = {
  kind: "account_transfer";
  account: string;
  token: SpecificOrAny<TokenRef>;
};

export type AmountDirection = "at_least" | "at_most";

export type AccountSwapTrigger = {
  kind: "account_swap";
  account: string;
  token: SpecificOrAny<TokenRef>;
  amount: SpecificOrAny<number>;
  /** Comparator on the swap size. Only meaningful when `amount.mode`
   *  is `"specific"`; ignored when amount is `"any"`. Defaults to
   *  `"at_least"` for triggers saved before this field shipped. */
  amountDirection: AmountDirection;
};

/** Wall-clock unit shown in the editor. Stored alongside the duration
 *  so the editor round-trips the user's chosen unit; the on-chain wire
 *  format is always seconds. */
export type TimeElapsedUnit = "minutes" | "hours" | "days";

/** Hard cap on TimeElapsed durations. Mirrors the on-chain
 *  `MAX_TIME_ELAPSED_SECS` constant (~366 days). */
export const MAX_TIME_ELAPSED_SECS = 366 * 24 * 60 * 60;

/** UI-level cap on TimeElapsed durations: 30 days. Tighter than the
 *  on-chain limit; longer cadences should be expressed as chained rules
 *  rather than a single very long sleep. Applied as both a value clamp
 *  per unit and a re-clamp when the user switches units. */
export const UI_MAX_TIME_ELAPSED_BY_UNIT: Record<TimeElapsedUnit, number> = {
  minutes: 30 * 24 * 60, // 43200
  hours: 30 * 24,        // 720
  days: 30,
};

export function clampTimeElapsed(
  value: number | null,
  unit: TimeElapsedUnit,
): number | null {
  if (value == null) return null;
  return Math.min(Math.max(value, 1), UI_MAX_TIME_ELAPSED_BY_UNIT[unit]);
}

/** Convert a (value, unit) pair to seconds. Floors to integer because
 *  the on-chain field is u32. */
export function timeElapsedToSecs(value: number, unit: TimeElapsedUnit): number {
  const multiplier =
    unit === "minutes" ? 60 : unit === "hours" ? 3_600 : 86_400;
  return Math.floor(value * multiplier);
}

/** Wall-clock delay since automation creation. Fires once when the
 *  duration has elapsed. The keeper's `time_watcher` ticks at minute
 *  resolution, so this is for human-scale schedules ("5 min", "2 hr"),
 *  not sub-minute triggers.
 *
 *  Stored as a (value, unit) pair so the chip can render "5 minutes"
 *  rather than "300 seconds"; converted to u32 seconds at submission
 *  time via `timeElapsedToSecs`. */
export type TimeElapsedTrigger = {
  kind: "time_elapsed";
  /** Magnitude in `unit`. Always > 0. */
  value: number;
  unit: TimeElapsedUnit;
};

/** Fires when the rule's input token price has moved a given percentage
 *  relative to the effective fill price recorded when the upstream rule
 *  executed. Only valid on downstream, consume-upstream-output chain rules.
 *
 *  `upstream` — the upstream automation PDA (populated at chain-build time
 *  from `nodePdas[upstreamIndex]`; null while editing the draft).
 *  `direction` — "grow" = price grew above fill, "drop" = dropped below fill.
 *  `pctBps`   — movement threshold in basis points (100 = 1%, 500 = 5%). */
export type PriceRelativeToFillTrigger = {
  kind: "price_relative_to_fill";
  upstream: PublicKey;
  direction: "grow" | "drop";
  pctBps: number;
};

export type Trigger =
  | AssetPriceTrigger
  | AccountTransferTrigger
  | AccountSwapTrigger
  | TimeElapsedTrigger
  | PriceRelativeToFillTrigger;

export type TriggerKind = Trigger["kind"];

/* ── Actions ───────────────────────────────────────────────────────── */

export type TransferAction = {
  kind: "transfer";
  token: TokenRef;
  amount: number;
  destination: string;
};

export type SwapAction = {
  kind: "swap";
  inputToken: TokenRef;
  outputToken: TokenRef;
  amount: number;
  /** Optional pubkey of a downstream automation. When set, A's swap
   *  output ATA = B's input ATA (i.e., the next-fire fuel for the
   *  linked rule). UI uses this for chain visualization + cycle
   *  detection. The on-chain handler doesn't enforce anything special
   *  about it — destination routing is the actual fund-flow primitive. */
  linkedDownstream?: string;
  /** When true, the keeper resolves `amount_in` at fire time from the
   *  PDA's input-ATA balance instead of using the static `amount`
   *  field above. Only meaningful for the downstream of an
   *  `inverted_pair` chain link. The on-chain program treats `amount`
   *  as informational regardless (see execute_swap.rs:210). */
  consumeUpstreamOutput?: boolean;
};

export type Action = TransferAction | SwapAction;

export type ActionKind = Action["kind"];

/** Resolved (non-draft) automation spec produced by the builder and
 *  consumed by the deposit flow and chain library. This type is defined
 *  here (lib/types) so non-UI modules (linked-chains, keeper) can import
 *  it without pulling in React component code. ConditionalBuilder
 *  re-exports it for backward compatibility. */
export type BuilderResult = {
  triggers: Trigger[];
  triggerOperators: TriggerOperator[];
  actions: Action[];
  actionOperators: ActionOperator[];
  cadence: Cadence;
  minIntervalSecs: number;
};

/* ── Drafts (in-flight builder state with nullable fields) ─────────── */

export type DraftAssetPrice = {
  kind: "asset_price";
  asset: AssetRef | null;
  quote: QuoteRef;
  comparator: "above" | "below";
  threshold: number | null;
  oracle: OracleSource | null;
};

export type DraftAccountTransfer = {
  kind: "account_transfer";
  account: string | null;
  token: SpecificOrAny<TokenRef | null>;
};

export type DraftAccountSwap = {
  kind: "account_swap";
  account: string | null;
  token: SpecificOrAny<TokenRef | null>;
  amount: SpecificOrAny<number | null>;
  amountDirection: AmountDirection;
};

export type DraftTimeElapsed = {
  kind: "time_elapsed";
  /** Editor-input value; null while empty. Resolves to `value` on the
   *  frozen `TimeElapsedTrigger` once non-null. */
  value: number | null;
  unit: TimeElapsedUnit;
};

/** In-flight draft for PriceRelativeToFill. `upstream` is null while
 *  editing (it's resolved at chain-build time from nodePdas[i-1]);
 *  `pctBps` is null while the percent input is empty. */
export type DraftPriceRelativeToFill = {
  kind: "price_relative_to_fill";
  upstream: PublicKey | null;
  direction: "grow" | "drop";
  pctBps: number | null;
};

export type DraftTrigger =
  | { kind: null }
  | DraftAssetPrice
  | DraftAccountTransfer
  | DraftAccountSwap
  | DraftTimeElapsed
  | DraftPriceRelativeToFill;

export type DraftTransfer = {
  kind: "transfer";
  token: TokenRef | null;
  amount: number | null;
  destination: string | null;
};

export type DraftSwap = {
  kind: "swap";
  inputToken: TokenRef | null;
  outputToken: TokenRef | null;
  amount: number | null;
  /** When this draft is part of a linked chain, points at the
   *  downstream automation's pubkey (set after PDA derivation in the
   *  chain-deposit flow) or, during pre-funding, at a sentinel
   *  describing the link target by chain index. The on-chain
   *  `Swap.destination` is what does the actual fund routing — this
   *  field is purely informational for the UI/chain visualizer and
   *  for cycle detection. */
  linkedDownstream?: string;
  /** Mirror of `SwapAction.consumeUpstreamOutput` for the in-flight
   *  draft state. UI only renders the toggle when the parent chain
   *  link classifies as `inverted_pair`. */
  consumeUpstreamOutput?: boolean;
};

export type DraftAction =
  | { kind: null }
  | DraftTransfer
  | DraftSwap;

/* ── Cadence (control-flow) ────────────────────────────────────────── */

/** Maps 1:1 to the on-chain `Cadence` enum.
 *
 *  - `once`   — fire one time when the trigger is met. The only cadence the
 *               builder produces directly; multi-fire behavior is expressed
 *               by linked-chain self-links and back-link loops.
 *  - `repeat` — fire up to `total` times. Produced by `loopModeToCadence`
 *               for "frequency" loops.
 *  - `until`  — fire repeatedly while now < `unixDeadline`. Produced by
 *               `loopModeToCadence` for "infinite" loops.
 *
 *  `minIntervalSecs` is the user-set throttle between consecutive fires and
 *  is enforced on-chain regardless of cadence kind. `0` = no floor.
 */
export type Cadence =
  | { kind: "once" }
  | { kind: "repeat"; total: number }
  | { kind: "until"; unixDeadline: number };

export type CadenceKind = Cadence["kind"];

/** Default cadence — every rule the standalone builder produces uses this.
 *  Loops override the cadence at chain submit time. */
export const DEFAULT_CADENCE: Cadence = { kind: "once" };
export const DEFAULT_MIN_INTERVAL_SECS = 0;

/* ── Persisted automation ──────────────────────────────────────────── */

export type TriggerOperator = "and" | "or";
export type ActionOperator = "then" | "and";

export type Automation = {
  id: string;
  schemaVersion: 3;
  triggers: Trigger[];
  /** Operators between adjacent triggers. Length = triggers.length - 1.
   *  Default is "and" for backward-compat. "or"-followed triggers render with
   *  parentheses for visual precedence. */
  triggerOperators: TriggerOperator[];
  actions: Action[];
  /** Operators between adjacent actions. Length = actions.length - 1.
   *  Default is "then" — sequential. "and"-followed actions render with
   *  parentheses to indicate they execute together. */
  actionOperators: ActionOperator[];
  /** Control-flow for this rule. Standalone rules are always `once`; chain
   *  members get `repeat` / `until` overridden onto them by
   *  `loopModeToCadence` at submit time. Defaults to `once` for records
   *  persisted before loops shipped — see `loadAutomations`. */
  cadence: Cadence;
  /** Minimum seconds between consecutive fires. `0` = no floor. */
  minIntervalSecs: number;
  running: boolean;
  runs: number;
  lastCheck: string;
  createdAt: string;
  /** On-chain Automation PDA (base58). Present for funded automations;
   *  absent for drafts that never reached `create_automation`. */
  pubkey?: string;
  /** Signature of the `create_automation` tx that funded this automation. */
  signature?: string;
  /** On-chain nonce assigned by the program at create time. Useful for
   *  re-deriving the PDA without re-fetching the account. */
  nonce?: string;
  /** ISO timestamp when on-chain `finished` was first observed as true.
   *  Set by `useOnChainAutomationSync`. The automation is in its terminal
   *  state and the keeper has stopped polling it. */
  executedAt?: string;
  /** ISO timestamp when the on-chain account was first observed missing
   *  (i.e., owner closed it). Mutually exclusive with `executedAt` in
   *  practice. */
  closedAt?: string;
  /** Chain membership metadata. Present iff this automation was created
   *  as part of a LinkedChainBuilder flow. Standalone rules (the only
   *  shape pre-chain-feature) leave this undefined and behave exactly
   *  as they did before. */
  link?: ChainLink;
};

/** Maximum number of linked rules per chain. Cap is enforced both in
 *  the LinkedChainBuilder UI and in the chain-creation flow. Larger
 *  chains start running into transaction-size limits (each rule's
 *  create_automation_swap_linked ix + ATA creates is ~600 bytes
 *  serialized; 3 nodes plus ATAs comfortably fit in one v0 tx). */
export const MAX_CHAIN_LENGTH = 3;

/** Default count for "Loop · cycles" mode. The user can edit this in
 *  the LoopSlot's cycles input before saving. Picked at 10 because the
 *  prototypical use case (USDC ↔ token arb) compounds slippage every
 *  cycle; 10 is enough to feel "looped" without burning the deposit on
 *  losses. */
export const DEFAULT_LOOP_CYCLES = 10;

/** "Far future" deadline for `Cadence::Until` infinite loops.
 *  2099-12-31, well beyond any realistic chain runtime. The on-chain
 *  validation only checks `unix_deadline > now` — there's no upper
 *  bound — so this is a soft "infinite" representation. */
export const INFINITE_LOOP_UNIX_DEADLINE = 4_102_444_800;

/** Default deposit multiplier when the user picks "Loop · infinite" on
 *  a SINGLE-RULE self-loop (not a chain — chains self-feed). Deposit =
 *  amount_in × this number. The rule will fire that many times before
 *  the input ATA depletes. User can close and reopen for a bigger
 *  deposit. */
export const SELF_LOOP_INFINITE_FUND_CYCLES = 100;

/** Loop topology applied to a chain at submit time. Set on the
 *  LinkedChainBuilder and threaded through to `sendChainCreate`, which
 *  overrides each node's cadence + computes the head's seed amount
 *  accordingly. `null` = no loop (linear chain, terminal at last
 *  rule). */
export type LoopMode =
  | { kind: "frequency"; cycles: number }
  | { kind: "infinite" };

/** Where a linked rule routes its output. Persisted on the Automation
 *  record (and mirrored into the on-chain `Swap.destination` at create
 *  time). The chain head sets this to the next rule's id; the chain
 *  tail can either set it to a downstream rule (forming a forward
 *  chain) or leave it unset (terminal — a finite cascade). For a
 *  perpetual loop, the tail's `chainNext` points back at the chain
 *  head — the chain head's input ATA is the destination, so post-swap
 *  output refills it for the next cycle. */
export type ChainLinkTarget =
  | { kind: "rule"; ruleId: string }
  | { kind: "loopBack" };

/** Per-rule chain metadata. Persisted alongside the Automation record
 *  so the Active Strategies UI can render the chain badge, the cascade-
 *  delete warning can enumerate siblings, and the keeper-side error
 *  surface can attribute "no funds yet" failures to upstream stalls. */
export type ChainLink = {
  /** UUID shared by every rule in the same chain. */
  chainId: string;
  /** 0-indexed position within the chain. 0 = head (gets the seed
   *  deposit). */
  position: number;
  /** Total nodes in the chain. Repeated on every node so a single
   *  Automation record carries enough context to render the chain
   *  badge ("2 of 3"). */
  total: number;
  /** Where this rule's output goes. `null` = no downstream (the chain
   *  terminates here, finite cascade). */
  next: ChainLinkTarget | null;
  /** True for the rule that owns the seed deposit (always the head).
   *  Convenience flag — equivalent to `position === 0`. */
  isHead: boolean;
  /** Set on the head when the chain-creation tx failed and downstream
   *  rules weren't created. Lets the Active Strategies tab surface the
   *  error and offer a "retry funding" affordance. */
  fundingError?: string;
};

/** Classification of an adjacent rule pair in a chain. Drives the
 *  builder UI affordances (chip / badge) and the keeper-side dispatch
 *  (fixed amount vs. balance-resolved vs. bridge-then-fire). */
export type ChainLinkClass = "matched_mints" | "inverted_pair" | "bridge_required";

/** True iff the automation reached its terminal state on chain. */
export function isCompleted(a: Automation): boolean {
  return !!a.executedAt;
}

/** True iff the on-chain account was closed (manual refund). */
export function isClosed(a: Automation): boolean {
  return !!a.closedAt;
}

/** Drafts (no pubkey), Completed, and Closed automations should not show
 *  the live "Running" affordance — toggle, pulse-dot, etc. */
export function isTerminal(a: Automation): boolean {
  return isCompleted(a) || isClosed(a);
}

export type Execution = {
  id: string;
  strategyId: string;
  from: { token: string; amount: number };
  to: { token: string; amount: number };
  price: number;
  when: string;
  txShort: string;
};

export type Tweaks = {
  appearance: "auto" | "light" | "dark";
  accent: string;
};

/* ── Draft → resolved coercion helpers ─────────────────────────────── */

export function isTriggerComplete(draft: DraftTrigger): draft is Trigger {
  switch (draft.kind) {
    case null:
      return false;
    case "asset_price":
      return (
        draft.asset != null &&
        draft.threshold != null &&
        draft.threshold > 0 &&
        draft.oracle != null
      );
    case "account_transfer":
      return (
        !!draft.account &&
        (draft.token.mode === "any" || draft.token.value != null)
      );
    case "account_swap":
      return (
        !!draft.account &&
        (draft.token.mode === "any" || draft.token.value != null) &&
        (draft.amount.mode === "any" ||
          (draft.amount.value != null && draft.amount.value > 0))
      );
    case "time_elapsed": {
      if (draft.value == null || draft.value <= 0) return false;
      const secs = timeElapsedToSecs(draft.value, draft.unit);
      return secs > 0 && secs <= MAX_TIME_ELAPSED_SECS;
    }
    case "price_relative_to_fill":
      return draft.upstream != null && draft.pctBps != null && draft.pctBps > 0;
  }
}

export function isActionComplete(draft: DraftAction): draft is Action {
  switch (draft.kind) {
    case null:
      return false;
    case "transfer":
      return (
        draft.token != null &&
        draft.amount != null &&
        draft.amount > 0 &&
        !!draft.destination
      );
    case "swap":
      return (
        draft.inputToken != null &&
        draft.outputToken != null &&
        draft.amount != null &&
        draft.amount > 0
      );
  }
}

/** Quick-check if a chain's mint flow is consistent — every
 *  upstream rule's outputMint must equal its downstream rule's
 *  inputMint, otherwise the destination ATA accumulates a token the
 *  downstream can't spend. Returns null when valid; a node-index
 *  pair when invalid. */
export function validateChainMintFlow(
  swaps: { inputToken: TokenRef; outputToken: TokenRef }[],
  next: (ChainLinkTarget | null)[],
): { fromIndex: number; toIndex: number } | null {
  for (let i = 0; i < swaps.length; i++) {
    const link = next[i];
    if (!link) continue;
    const targetIndex =
      link.kind === "loopBack" ? 0 : swaps.findIndex((_, idx) => `pos:${idx}` === link.ruleId);
    if (targetIndex < 0 || targetIndex >= swaps.length) continue;
    if (swaps[i].outputToken.mint !== swaps[targetIndex].inputToken.mint) {
      return { fromIndex: i, toIndex: targetIndex };
    }
  }
  return null;
}

export const EMPTY_TRIGGER: DraftTrigger = { kind: null };
export const EMPTY_ACTION: DraftAction = { kind: null };
