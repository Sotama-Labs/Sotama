import type {
  ActionKind,
  CadenceKind,
  DraftAction,
  DraftTrigger,
  TriggerKind,
} from "./types";

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

export type TriggerCategoryId = "asset_price" | "track_account";

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
   *  in the picker. */
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

export const ACTION_KINDS: ActionKindMeta[] = [TRANSFER_ACTION, SWAP_ACTION];

/* ── Trigger catalog ───────────────────────────────────────────────── */

const GENERAL_ACTIONS: ActionKind[] = ["transfer", "swap"];

const ASSET_PRICE: TriggerKindMeta = {
  kind: "asset_price",
  label: "Asset price",
  description: "Fires when a price crosses a threshold.",
  compatibleActions: GENERAL_ACTIONS,
  empty: () => ({
    kind: "asset_price",
    asset: null,
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
    amountDirection: "at_least",
  }),
};

export const TRIGGER_CATEGORIES: TriggerCategoryMeta[] = [
  {
    id: "asset_price",
    label: "Asset Price",
    description: "Track any asset (crypto, equity, FX, commodity, metal) against USD or a quote asset",
    kinds: [ASSET_PRICE],
  },
  {
    id: "track_account",
    label: "Account Activity",
    description: "Track a wallet's activity",
    kinds: [ACCOUNT_TRANSFER, ACCOUNT_SWAP],
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

/* ── Cadence-aware menu filtering ─────────────────────────────────────
   The trigger/action menus shown in the builder depend on the current
   cadence (If / While / For), because not every shape reads naturally in
   English under every cadence.
   ───────────────────────────────────────────────────────────────────── */

const TRIGGERS_BY_CADENCE: Record<CadenceKind, ReadonlySet<TriggerKind>> = {
  once: new Set<TriggerKind>(["asset_price", "account_transfer", "account_swap"]),
  // While reads as a standing predicate. Only asset_price fits naturally —
  // "While SOL price < $180" is a true predicate.
  until: new Set<TriggerKind>(["asset_price"]),
  // For reads as "the next N times that …". Event triggers fit.
  repeat: new Set<TriggerKind>([
    "asset_price",
    "account_transfer",
    "account_swap",
  ]),
};

const ACTIONS_BY_CADENCE: Record<CadenceKind, ReadonlySet<ActionKind>> = {
  once: new Set<ActionKind>(["transfer", "swap"]),
  // Swap drops from `until` because the deposit must cover all fires up
  // front (see SwapUntilNotSupported on-chain) and `until` has no bounded
  // run count.
  until: new Set<ActionKind>(["transfer"]),
  repeat: new Set<ActionKind>(["transfer", "swap"]),
};

/** Categories visible in the trigger picker for the given cadence. A
 *  category survives if at least one of its kinds is allowed under the
 *  cadence; the remaining kinds inside that category are filtered too. */
export function triggerCategoriesForCadence(
  cadence: CadenceKind,
): TriggerCategoryMeta[] {
  const allowed = TRIGGERS_BY_CADENCE[cadence];
  return TRIGGER_CATEGORIES.map((c) => ({
    ...c,
    kinds: c.kinds.filter((k) => allowed.has(k.kind)),
  })).filter((c) => c.kinds.length > 0);
}

export function isTriggerKindAllowedForCadence(
  kind: TriggerKind,
  cadence: CadenceKind,
): boolean {
  return TRIGGERS_BY_CADENCE[cadence].has(kind);
}

export function isActionKindAllowedForCadence(
  kind: ActionKind,
  cadence: CadenceKind,
): boolean {
  return ACTIONS_BY_CADENCE[cadence].has(kind);
}

/** Filter actionsForTriggers' result by cadence. Used by the action
 *  picker so cadence + trigger-compatibility are both honored. */
export function actionsForCadenceAndTriggers(
  cadence: CadenceKind,
  completedTriggerKinds: TriggerKind[],
): ActionKindMeta[] {
  const byTrigger = actionsForTriggers(completedTriggerKinds);
  const allowedByCadence = ACTIONS_BY_CADENCE[cadence];
  return byTrigger.filter((a) => allowedByCadence.has(a.kind));
}
