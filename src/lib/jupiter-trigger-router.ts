/* ─────────────────────────────────────────────────────────────────────
   Jupiter Trigger v2 router.

   Classifies an Automation into one of two execution venues:

     - "jupiter_trigger" — single USD-threshold rule that boils down to
       "if mint X price ⋛ $Y then swap A→B once". These delegate to
       Jupiter's Trigger Order API V2, which monitors the price off-chain,
       holds the deposit in a Privy-managed vault, and executes the swap
       through Jupiter routing when the threshold is crossed. Off-loading
       these rules removes them from the Sotama keeper's polling loop.

     - "keeper" — anything else: composed conditions, looped cadences,
       linked-downstream chains, account-side triggers, multi-action
       sequences, transfers, etc. The Sotama keeper continues to handle
       these on-chain.

   Pure function: no I/O, no clock, no randomness. Two eligibility checks
   the router can't do without network calls (Token-2022 detection and
   the $10 USD min order size) are deferred to the dispatcher, which
   should fall back to the keeper if either fails at runtime.
   ───────────────────────────────────────────────────────────────────── */

import type { Automation } from "./types";

/** Stable string codes for why a rule was kept on the keeper. Used by the
 *  dispatcher for logging and by the UI to surface "this rule could run
 *  on Jupiter except…" hints. */
export type KeeperReason =
  | "multiple_triggers"
  | "multiple_actions"
  | "trigger_not_asset_price"
  | "action_not_swap"
  | "looped_cadence"
  | "linked_downstream"
  | "quote_not_usd"
  | "asset_not_crypto"
  | "trigger_asset_no_mint"
  | "trigger_mint_not_in_swap"
  | "swap_same_input_output"
  | "non_positive_amount";

/** Parameters for a Jupiter Trigger v2 single order, derived from the
 *  Automation at classification time so the dispatcher doesn't re-walk
 *  the automation. Quantities are in smallest unit (matching Jupiter's
 *  wire format). `expiresAtMs` and `slippageBps` are intentionally not
 *  set here — those are dispatcher-time concerns and depend on the
 *  caller's policy. */
export type JupiterTriggerParams = {
  inputMint: string;
  outputMint: string;
  triggerMint: string;
  triggerCondition: "above" | "below";
  triggerPriceUsd: number;
  /** Smallest-unit input amount as a base-10 string (e.g. 100 USDC →
   *  "100000000"). Stringly-typed because input amounts can exceed
   *  2^53 for low-decimal high-supply tokens. */
  inputAmount: string;
};

export type RouteDecision =
  | { route: "jupiter_trigger"; params: JupiterTriggerParams }
  | { route: "keeper"; reason: KeeperReason };

export function routeAutomation(a: Automation): RouteDecision {
  if (a.triggers.length !== 1) {
    return { route: "keeper", reason: "multiple_triggers" };
  }
  if (a.actions.length !== 1) {
    return { route: "keeper", reason: "multiple_actions" };
  }

  const trigger = a.triggers[0];
  if (trigger.kind !== "asset_price") {
    return { route: "keeper", reason: "trigger_not_asset_price" };
  }

  const action = a.actions[0];
  if (action.kind !== "swap") {
    return { route: "keeper", reason: "action_not_swap" };
  }

  if (a.cadence.kind !== "once") {
    return { route: "keeper", reason: "looped_cadence" };
  }

  if (action.linkedDownstream) {
    return { route: "keeper", reason: "linked_downstream" };
  }

  if (trigger.quote.kind !== "usd") {
    return { route: "keeper", reason: "quote_not_usd" };
  }

  if (trigger.asset.assetClass !== "Crypto") {
    return { route: "keeper", reason: "asset_not_crypto" };
  }

  const triggerMint = trigger.asset.mint;
  if (!triggerMint) {
    return { route: "keeper", reason: "trigger_asset_no_mint" };
  }

  const inputMint = action.inputToken.mint;
  const outputMint = action.outputToken.mint;

  if (inputMint === outputMint) {
    return { route: "keeper", reason: "swap_same_input_output" };
  }

  if (triggerMint !== inputMint && triggerMint !== outputMint) {
    return { route: "keeper", reason: "trigger_mint_not_in_swap" };
  }

  if (!(action.amount > 0)) {
    return { route: "keeper", reason: "non_positive_amount" };
  }

  const decimals = action.inputToken.decimals;
  const rawAmount = BigInt(Math.floor(action.amount * 10 ** decimals));

  return {
    route: "jupiter_trigger",
    params: {
      inputMint,
      outputMint,
      triggerMint,
      triggerCondition: trigger.comparator,
      triggerPriceUsd: trigger.threshold,
      inputAmount: rawAmount.toString(),
    },
  };
}
