/* ─────────────────────────────────────────────────────────────────────
   On-chain support flags — single source of truth for which trigger /
   action kinds are wired up to the deployed `sotama_automations`
   program + keeper bot.

   To enable a kind once it's implemented:
     1. Set its entry below to `true`.
     2. Make sure the on-chain program + keeper actually handle it.
     3. Update `DepositSheet.getOnChainSpec()` (in src/components/
        DepositSheet.tsx) so the create_automation tx is built with the
        new field shape.

   The UI greys out unsupported kinds in the picker but still renders
   them in the edit view of saved automations — flipping a flag from
   true → false will not corrupt local storage.
   ───────────────────────────────────────────────────────────────────── */

import type { ActionKind, TriggerKind } from "./types";
import type { TriggerCategoryMeta } from "./catalog";

export const SUPPORTED_TRIGGER_KINDS: Record<TriggerKind, boolean> = {
  account_transfer: true,             // wired ✓ — Helius transactionSubscribe + execute_automation
  account_swap: true,                 // wired ✓ — Helius txSubscribe + DEX program filter
  asset_price: true,                  // wired ✓ — Pyth Hermes/Lazer poll in keeper
  time_elapsed: true,                 // wired ✓ — keeper time_watcher (60s tick). Needs program redeploy with TriggerSpec::TimeElapsed before this flag is honored on-chain.
  price_relative_to_fill: true,       // wired ✓ — keeper fill-price watcher; on-chain PriceRelativeToFill variant. Only valid on downstream consume-upstream chain rules.
};

export const SUPPORTED_ACTION_KINDS: Record<ActionKind, boolean> = {
  transfer: true,                     // wired ✓ — SOL via execute_automation, SPL via execute_automation_spl
  swap: true,                         // wired ✓ — execute_swap (Orca Whirlpool CPI). MVP: hardcoded pool registry, no quote/slippage UI yet
};

export function isTriggerSupported(kind: TriggerKind): boolean {
  return SUPPORTED_TRIGGER_KINDS[kind] === true;
}

export function isActionSupported(kind: ActionKind): boolean {
  return SUPPORTED_ACTION_KINDS[kind] === true;
}

/** A trigger category is "supported" if at least one of its kinds is.
 *  Lets users expand a partially-implemented category (e.g. Account
 *  Activity, where Transfers is live but Swaps is not). */
export function isTriggerCategorySupported(c: TriggerCategoryMeta): boolean {
  return c.kinds.some((k) => isTriggerSupported(k.kind));
}

export const COMING_SOON_LABEL = "Coming soon";
