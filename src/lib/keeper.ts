"use client";

import type { Automation } from "./types";

export type SubmitResult = {
  id: string;
  status: "pending" | "active" | "rejected";
  forwardedToKeeper: boolean;
};

/** Submit a finalized automation through the single integration boundary.
 *  Today this hits the local Next route which (a) persists in-memory and
 *  (b) optionally forwards to the keeper URL. The frontend never talks to
 *  the keeper directly — everything goes through /api/automations. */
export async function submitAutomation(automation: Automation): Promise<SubmitResult> {
  const res = await fetch("/api/automations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(automation),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Submit failed: ${res.status} ${text}`);
  }
  return (await res.json()) as SubmitResult;
}

export async function deleteAutomation(id: string): Promise<void> {
  const res = await fetch(`/api/automations?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}
