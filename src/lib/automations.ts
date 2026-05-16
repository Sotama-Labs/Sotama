"use client";

import type {
  Action,
  ActionOperator,
  Automation,
  Cadence,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerOperator,
} from "./types";
import { DEFAULT_CADENCE, DEFAULT_MIN_INTERVAL_SECS, isActionComplete, isTriggerComplete } from "./types";

const DEFAULT_TRIGGER_OP: TriggerOperator = "and";

/** Migrate asset_price triggers saved before the AssetRef refactor.
 *  Old shape: { token: TokenRef, quote: { kind: "token" } & TokenRef }
 *  New shape: { asset: AssetRef, quote: { kind: "usd" } | { kind: "asset", asset: AssetRef } } */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateAssetPriceTrigger(t: any): any {
  if (t.kind !== "asset_price") return t;
  const out = { ...t };
  // Migrate token → asset. Old TokenRefs sometimes lack `symbol` (manual
  // entries pre-symbol gating); fall back to a short mint slice so the
  // AssetPicker pill renders something rather than `undefined`.
  if ("token" in out && !("asset" in out)) {
    const tok = out.token;
    const display = tok?.symbol || tok?.mint?.slice(0, 4) || "?";
    out.asset = {
      ...tok,
      symbol: tok?.symbol || display,
      assetClass: "Crypto",
      displaySymbol: display,
    };
    delete out.token;
  }
  // Migrate old quote: { kind: "token", mint, symbol, ... } → { kind: "asset", asset: AssetRef }
  if (out.quote?.kind === "token") {
    const q = out.quote;
    const display = q?.symbol || q?.mint?.slice(0, 4) || "?";
    out.quote = {
      kind: "asset",
      asset: {
        ...q,
        symbol: q?.symbol || display,
        assetClass: "Crypto",
        displaySymbol: display,
      },
    };
  }
  return out;
}
/** Backfill `amountDirection` for account_swap triggers saved before
 *  the field shipped. Old rules implicitly meant "at least X" so we
 *  default to that. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateAccountSwapTrigger(t: any): any {
  if (t?.kind !== "account_swap") return t;
  if (t.amountDirection === "at_least" || t.amountDirection === "at_most") return t;
  return { ...t, amountDirection: "at_least" };
}
const DEFAULT_ACTION_OP: ActionOperator = "then";

function fillOperators<T extends string>(
  ops: T[] | undefined,
  expectedLength: number,
  fallback: T,
): T[] {
  const safe = Array.isArray(ops) ? ops.slice(0, expectedLength) : [];
  while (safe.length < expectedLength) safe.push(fallback);
  return safe;
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value && Number.isFinite(Date.parse(value))) return value;
  if (Number.isFinite(Date.parse(fallback))) return fallback;
  return new Date().toISOString();
}

/** Storage key for a given wallet's automations. Namespacing by wallet
 *  pubkey isolates one user's saved strategies from another's on the
 *  same browser — without this, connecting wallet B would surface
 *  wallet A's active strategies because both read from a single global
 *  key. `null` is the pre-connect/disconnect bucket (empty by design
 *  so we never leak across sessions). */
function storageKey(owner: string | null): string {
  return owner ? `sotama:automations:v2:${owner}` : "sotama:automations:v2:__none__";
}

export function newAutomationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `a_${crypto.randomUUID()}`;
  }
  return `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function loadAutomations(owner: string | null): Automation[] {
  if (typeof window === "undefined" || !owner) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Automation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a.schemaVersion === 3)
      .map((a) => ({
        ...a,
        triggers: a.triggers
          .map(migrateAssetPriceTrigger)
          .map(migrateAccountSwapTrigger),
        triggerOperators: fillOperators(
          a.triggerOperators,
          Math.max(0, a.triggers.length - 1),
          DEFAULT_TRIGGER_OP,
        ),
        actionOperators: fillOperators(
          a.actionOperators,
          Math.max(0, a.actions.length - 1),
          DEFAULT_ACTION_OP,
        ),
        // Records written before loops shipped have no cadence — default
        // them to `once` so they keep their original single-shot behavior.
        cadence: a.cadence ?? DEFAULT_CADENCE,
        minIntervalSecs: a.minIntervalSecs ?? DEFAULT_MIN_INTERVAL_SECS,
        lastCheck: normalizeTimestamp(a.lastCheck, a.createdAt),
      }));
  } catch {
    return [];
  }
}

export function saveAutomations(owner: string | null, items: Automation[]) {
  if (typeof window === "undefined" || !owner) return;
  try {
    window.localStorage.setItem(storageKey(owner), JSON.stringify(items));
  } catch {
    // quota / private mode — skip
  }
}

/** Coerce a list of drafts to resolved triggers if every slot is complete. */
export function freezeTriggers(drafts: DraftTrigger[]): Trigger[] | null {
  if (drafts.length === 0) return null;
  const out: Trigger[] = [];
  for (const d of drafts) {
    if (!isTriggerComplete(d)) return null;
    out.push(d);
  }
  return out;
}

export function freezeActions(drafts: DraftAction[]): Action[] | null {
  if (drafts.length === 0) return null;
  const out: Action[] = [];
  for (const d of drafts) {
    if (!isActionComplete(d)) return null;
    out.push(d);
  }
  return out;
}

export function makeAutomation(
  triggers: Trigger[],
  actions: Action[],
  triggerOperators: TriggerOperator[],
  actionOperators: ActionOperator[],
  cadence: Cadence,
  minIntervalSecs: number,
  overrides: Partial<
    Pick<
      Automation,
      | "id"
      | "running"
      | "runs"
      | "lastCheck"
      | "createdAt"
      | "pubkey"
      | "signature"
      | "nonce"
      | "executedAt"
      | "closedAt"
    >
  > = {},
): Automation {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? newAutomationId(),
    schemaVersion: 3,
    triggers,
    triggerOperators: fillOperators(
      triggerOperators,
      Math.max(0, triggers.length - 1),
      DEFAULT_TRIGGER_OP,
    ),
    actions,
    actionOperators: fillOperators(
      actionOperators,
      Math.max(0, actions.length - 1),
      DEFAULT_ACTION_OP,
    ),
    cadence,
    minIntervalSecs,
    running: overrides.running ?? true,
    runs: overrides.runs ?? 0,
    lastCheck: normalizeTimestamp(overrides.lastCheck, now),
    createdAt: overrides.createdAt ?? now,
    pubkey: overrides.pubkey,
    signature: overrides.signature,
    nonce: overrides.nonce,
    executedAt: overrides.executedAt,
    closedAt: overrides.closedAt,
  };
}
