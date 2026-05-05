"use client";

import type {
  Action,
  ActionOperator,
  Automation,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerOperator,
} from "./types";
import { isActionComplete, isTriggerComplete } from "./types";

const DEFAULT_TRIGGER_OP: TriggerOperator = "and";
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

const STORAGE_KEY = "sotama:automations:v2";

export function newAutomationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `a_${crypto.randomUUID()}`;
  }
  return `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function loadAutomations(): Automation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Automation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a.schemaVersion === 2)
      .map((a) => ({
        ...a,
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
      }));
  } catch {
    return [];
  }
}

export function saveAutomations(items: Automation[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
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
    schemaVersion: 2,
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
    running: overrides.running ?? true,
    runs: overrides.runs ?? 0,
    lastCheck: overrides.lastCheck ?? "just now",
    createdAt: overrides.createdAt ?? now,
    pubkey: overrides.pubkey,
    signature: overrides.signature,
    nonce: overrides.nonce,
    executedAt: overrides.executedAt,
    closedAt: overrides.closedAt,
  };
}
