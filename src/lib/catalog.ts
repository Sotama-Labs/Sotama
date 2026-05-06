import type { ActionKind, DraftAction, DraftTrigger, TriggerKind } from "./types";

/* ─────────────────────────────────────────────────────────────────────
   Builder catalog — modular trigger/action metadata.

   • Each trigger kind declares which action kinds are compatible.
   • Each action kind declares whether it should appear before any
     trigger has been fully configured (`availableWithoutTrigger`).
   • The action menu is derived: intersection of compatible-actions
     across completed triggers — or the default-eligible subset when
     no trigger is complete yet. Adding new trigger or action kinds
     only requires extending the constants below; no editor logic
     needs hardcoded checks against specific kinds.
   ───────────────────────────────────────────────────────────────────── */

export type TriggerCategoryId = "token_price" | "track_account" | "staking";

export type TriggerKindMeta = {
  kind: TriggerKind;
  /** Label used in the sub-kind list (category-relative phrasing). */
  label: string;
  description?: string;
  empty: () => DraftTrigger;
  /** Action kinds that make sense paired with this trigger. */
  compatibleActions: ActionKind[];
};

export type TriggerCategoryMeta = {
  id: TriggerCategoryId;
  label: string;
  description?: string;
  kinds: TriggerKindMeta[];
};

export type ActionKindMeta = {
  kind: ActionKind;
  label: string;
  description?: string;
  empty: () => DraftAction;
  /** When no trigger is completed yet, only actions with this flag show up
   *  in the picker. Actions whose semantics rely on trigger context (e.g.
   *  "restake the staking reward") set this to false. */
  availableWithoutTrigger: boolean;
};

/* ── Action catalog ────────────────────────────────────────────────── */

const TRANSFER_ACTION: ActionKindMeta = {
  kind: "transfer",
  label: "Transfer",
  description: "Move a token to another wallet.",
  availableWithoutTrigger: true,
  empty: () => ({
    kind: "transfer",
    token: null,
    amount: null,
    destination: null,
  }),
};

const SWAP_ACTION: ActionKindMeta = {
  kind: "swap",
  label: "Swap",
  description: "Convert one token to another.",
  availableWithoutTrigger: true,
  empty: () => ({
    kind: "swap",
    inputToken: null,
    outputToken: null,
    amount: null,
  }),
};

const RESTAKE_ACTION: ActionKindMeta = {
  kind: "restake",
  label: "Restake",
  description: "Compound the reward back into the stake account.",
  availableWithoutTrigger: false,
  empty: () => ({ kind: "restake", stakeAccount: null, voteAccount: null }),
};

const SELL_FOR_ACTION: ActionKindMeta = {
  kind: "sell_for",
  label: "Sell for token",
  description: "Swap the reward for another token.",
  availableWithoutTrigger: false,
  empty: () => ({ kind: "sell_for", outputToken: null }),
};

const TRANSFER_REWARD_ACTION: ActionKindMeta = {
  kind: "transfer_reward",
  label: "Transfer",
  description: "Send the reward to another wallet.",
  availableWithoutTrigger: false,
  empty: () => ({
    kind: "transfer_reward",
    stakeAccount: null,
    destination: null,
  }),
};

export const ACTION_KINDS: ActionKindMeta[] = [
  TRANSFER_ACTION,
  SWAP_ACTION,
  RESTAKE_ACTION,
  SELL_FOR_ACTION,
  TRANSFER_REWARD_ACTION,
];

/* ── Trigger catalog ───────────────────────────────────────────────── */

const GENERAL_ACTIONS: ActionKind[] = ["transfer", "swap"];
const STAKING_ACTIONS: ActionKind[] = ["restake", "sell_for", "transfer_reward"];

const TOKEN_PRICE: TriggerKindMeta = {
  kind: "token_price",
  label: "Token price",
  description: "Fires when an oracle price crosses a threshold.",
  compatibleActions: GENERAL_ACTIONS,
  empty: () => ({
    kind: "token_price",
    token: null,
    quote: { kind: "usd" },
    comparator: "below",
    threshold: null,
    oracle: null,
  }),
};

const ACCOUNT_TRANSFER: TriggerKindMeta = {
  kind: "account_transfer",
  label: "Transfers",
  description: "Fires when the watched address sends or receives a token.",
  compatibleActions: GENERAL_ACTIONS,
  empty: () => ({
    kind: "account_transfer",
    account: null,
    token: { mode: "any" },
  }),
};

const ACCOUNT_SWAP: TriggerKindMeta = {
  kind: "account_swap",
  label: "Swaps",
  description: "Fires when the watched address executes a swap.",
  compatibleActions: GENERAL_ACTIONS,
  empty: () => ({
    kind: "account_swap",
    account: null,
    token: { mode: "any" },
    amount: { mode: "any" },
  }),
};

const STAKING_AMOUNT: TriggerKindMeta = {
  kind: "staking_reward_amount",
  label: "By amount",
  description: "Fires when accumulated rewards exceed a threshold.",
  compatibleActions: STAKING_ACTIONS,
  empty: () => ({
    kind: "staking_reward_amount",
    stakeAccount: null,
    threshold: null,
  }),
};

const STAKING_TIME: TriggerKindMeta = {
  kind: "staking_reward_time",
  label: "On a schedule",
  description: "Fires on a recurring time interval.",
  compatibleActions: STAKING_ACTIONS,
  empty: () => ({
    kind: "staking_reward_time",
    stakeAccount: null,
    intervalDays: null,
  }),
};

export const TRIGGER_CATEGORIES: TriggerCategoryMeta[] = [
  {
    id: "token_price",
    label: "Token Price",
    description: "Track token price against USD or any quote token",
    kinds: [TOKEN_PRICE],
  },
  {
    id: "track_account",
    label: "Account Activity",
    description: "Track a wallet's activity",
    kinds: [ACCOUNT_TRANSFER, ACCOUNT_SWAP],
  },
  {
    id: "staking",
    label: "Staking",
    description: "Track staking metrics or rewards",
    kinds: [STAKING_AMOUNT, STAKING_TIME],
  },
];

/** Flat list, kept for any consumer that wants to look up a kind directly. */
export const TRIGGER_KINDS: TriggerKindMeta[] = TRIGGER_CATEGORIES.flatMap(
  (c) => c.kinds,
);

export function findTriggerCategoryForKind(
  kind: TriggerKind,
): TriggerCategoryMeta | undefined {
  return TRIGGER_CATEGORIES.find((c) => c.kinds.some((k) => k.kind === kind));
}

export function findTriggerMeta(kind: TriggerKind): TriggerKindMeta | undefined {
  return TRIGGER_KINDS.find((t) => t.kind === kind);
}

export function findActionMeta(kind: ActionKind): ActionKindMeta | undefined {
  return ACTION_KINDS.find((a) => a.kind === kind);
}

/* ── Action menu derivation ────────────────────────────────────────── */

/** Action menu given the kinds of currently-completed triggers.
 *  • No completed triggers → return actions flagged availableWithoutTrigger.
 *  • One or more         → intersect each trigger's compatibleActions list
 *                          and return the matching ActionKindMeta entries
 *                          in catalog order. */
export function actionsForTriggers(
  completedTriggerKinds: TriggerKind[],
): ActionKindMeta[] {
  if (completedTriggerKinds.length === 0) {
    return ACTION_KINDS.filter((a) => a.availableWithoutTrigger);
  }
  const sets = completedTriggerKinds.map((k) => {
    const meta = findTriggerMeta(k);
    return new Set<ActionKind>(meta?.compatibleActions ?? []);
  });
  const intersection = sets.reduce(
    (acc, s) => new Set([...acc].filter((x) => s.has(x))),
  );
  return ACTION_KINDS.filter((a) => intersection.has(a.kind));
}

/** Are the chosen action kinds all compatible with the chosen trigger kinds?
 *  Used by the save validator. */
export function actionsAreCompatible(
  completedTriggerKinds: TriggerKind[],
  actionKinds: ActionKind[],
): boolean {
  const allowed = new Set(
    actionsForTriggers(completedTriggerKinds).map((a) => a.kind),
  );
  return actionKinds.every((k) => allowed.has(k));
}
