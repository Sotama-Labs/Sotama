/* ─────────────────────────────────────────────────────────────────────
   Sotama automation schema (v2).
   Discriminated unions per trigger/action kind drive both the builder
   editors and the keeper wire format.
   ───────────────────────────────────────────────────────────────────── */

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

export type QuoteRef =
  | { kind: "usd" }
  | ({ kind: "token" } & TokenRef);

export type SpecificOrAny<T> =
  | { mode: "specific"; value: T }
  | { mode: "any" };

/** What the keeper should subscribe to for a price-driven trigger. */
export type OracleSource =
  | { kind: "pyth"; feedId: string; symbol: string }
  | { kind: "switchboard_pending"; symbol: string };

/* ── Triggers ──────────────────────────────────────────────────────── */

export type TokenPriceTrigger = {
  kind: "token_price";
  token: TokenRef;
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

export type AccountSwapTrigger = {
  kind: "account_swap";
  account: string;
  token: SpecificOrAny<TokenRef>;
  amount: SpecificOrAny<number>;
};

export type StakingRewardAmountTrigger = {
  kind: "staking_reward_amount";
  /** Stake account being monitored. The owner must have authorized the
   *  automation PDA as the stake account's withdraw and/or staker
   *  authority before the action can fire on-chain. */
  stakeAccount: string;
  threshold: number;
};

export type StakingRewardTimeTrigger = {
  kind: "staking_reward_time";
  stakeAccount: string;
  intervalDays: number;
};

export type Trigger =
  | TokenPriceTrigger
  | AccountTransferTrigger
  | AccountSwapTrigger
  | StakingRewardAmountTrigger
  | StakingRewardTimeTrigger;

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
};

export type RestakeAction = {
  kind: "restake";
  /** Stake account whose balance gets re-delegated. The PDA must be the
   *  staker authority (set by the owner before activating). */
  stakeAccount: string;
  /** Vote account to delegate to. Re-delegating to the same vote account
   *  the stake is already delegated to is the standard "compound rewards"
   *  flow on Solana — `DelegateStake` re-stakes the full balance,
   *  including accrued rewards. */
  voteAccount: string;
};

export type SellForAction = {
  kind: "sell_for";
  outputToken: TokenRef;
};

/** Staking-only: route the reward to an external destination. Token + amount
 *  are implicit (the staking reward in SOL); the user picks the stake account
 *  to monitor and the destination wallet to receive the reward. */
export type TransferRewardAction = {
  kind: "transfer_reward";
  stakeAccount: string;
  destination: string;
};

export type Action =
  | TransferAction
  | SwapAction
  | RestakeAction
  | SellForAction
  | TransferRewardAction;

export type ActionKind = Action["kind"];

/* ── Drafts (in-flight builder state with nullable fields) ─────────── */

export type DraftTokenPrice = {
  kind: "token_price";
  token: TokenRef | null;
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
};

export type DraftStakingRewardAmount = {
  kind: "staking_reward_amount";
  stakeAccount: string | null;
  threshold: number | null;
};

export type DraftStakingRewardTime = {
  kind: "staking_reward_time";
  stakeAccount: string | null;
  intervalDays: number | null;
};

export type DraftTrigger =
  | { kind: null }
  | DraftTokenPrice
  | DraftAccountTransfer
  | DraftAccountSwap
  | DraftStakingRewardAmount
  | DraftStakingRewardTime;

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
};

export type DraftRestake = {
  kind: "restake";
  stakeAccount: string | null;
  voteAccount: string | null;
};

export type DraftSellFor = {
  kind: "sell_for";
  outputToken: TokenRef | null;
};

export type DraftTransferReward = {
  kind: "transfer_reward";
  stakeAccount: string | null;
  destination: string | null;
};

export type DraftAction =
  | { kind: null }
  | DraftTransfer
  | DraftSwap
  | DraftRestake
  | DraftSellFor
  | DraftTransferReward;

/* ── Persisted automation ──────────────────────────────────────────── */

export type TriggerOperator = "and" | "or";
export type ActionOperator = "then" | "and";

export type Automation = {
  id: string;
  schemaVersion: 2;
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
  /** ISO timestamp when on-chain `executed` was first observed as true.
   *  Set by `useOnChainAutomationSync`. Single-shot — once set, the
   *  automation is in its terminal "Completed" state. */
  executedAt?: string;
  /** ISO timestamp when the on-chain account was first observed missing
   *  (i.e., owner closed it). Mutually exclusive with `executedAt` in
   *  practice. */
  closedAt?: string;
};

/** True iff the automation reached its terminal Completed state on chain. */
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
    case "token_price":
      return (
        draft.token != null &&
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
    case "staking_reward_amount":
      return (
        !!draft.stakeAccount &&
        draft.threshold != null &&
        draft.threshold > 0
      );
    case "staking_reward_time":
      return (
        !!draft.stakeAccount &&
        draft.intervalDays != null &&
        draft.intervalDays > 0
      );
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
    case "restake":
      return !!draft.stakeAccount && !!draft.voteAccount;
    case "sell_for":
      return draft.outputToken != null;
    case "transfer_reward":
      return !!draft.stakeAccount && !!draft.destination;
  }
}

export const EMPTY_TRIGGER: DraftTrigger = { kind: null };
export const EMPTY_ACTION: DraftAction = { kind: null };
