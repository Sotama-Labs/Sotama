"use client";

import type { Automation } from "./types";
import {
  routeAutomation,
  type JupiterTriggerParams,
  type KeeperReason,
} from "./jupiter-trigger-router";

export type SubmitResult = {
  id: string;
  status: "pending" | "active" | "rejected";
  forwardedToKeeper: boolean;
  /** Where the rule will execute. "jupiter_trigger" means the router
   *  classified it as a single USD-threshold swap eligible for Jupiter's
   *  Trigger Order v2; "keeper" means the Sotama keeper handles it. The
   *  current build still posts every rule through the keeper boundary —
   *  the Jupiter Trigger client is a separate slice — but the route is
   *  set so the dispatch site can switch on it once that ships. */
  route: "jupiter_trigger" | "keeper";
  /** Set when `route === "jupiter_trigger"`. Pre-computed so the eventual
   *  Jupiter dispatcher doesn't need to walk the Automation again. */
  jupiterParams?: JupiterTriggerParams;
  /** Set when `route === "keeper"`. The classifier's reason code, useful
   *  for "why didn't this go to Jupiter?" surfaces. */
  keeperReason?: KeeperReason;
};

/** Submit a finalized automation through the single integration boundary.
 *  Today this hits the local Next route which (a) persists in-memory and
 *  (b) optionally forwards to the keeper URL. The frontend never talks to
 *  the keeper directly — everything goes through /api/automations.
 *
 *  The router runs alongside the keeper submission so the result carries
 *  classification metadata. Once the Jupiter Trigger v2 client lands, the
 *  `route === "jupiter_trigger"` branch will short-circuit the keeper
 *  path and post the order to Jupiter instead. */
export async function submitAutomation(automation: Automation): Promise<SubmitResult> {
  const decision = routeAutomation(automation);

  const res = await fetch("/api/automations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(automation),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Submit failed: ${res.status} ${text}`);
  }
  const keeperResult = (await res.json()) as {
    id: string;
    status: "pending" | "active" | "rejected";
    forwardedToKeeper: boolean;
  };

  if (decision.route === "jupiter_trigger") {
    return { ...keeperResult, route: "jupiter_trigger", jupiterParams: decision.params };
  }
  return { ...keeperResult, route: "keeper", keeperReason: decision.reason };
}

export async function deleteAutomation(id: string): Promise<void> {
  const res = await fetch(`/api/automations?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}
