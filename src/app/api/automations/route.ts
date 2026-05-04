import { NextResponse } from "next/server";
import type { Automation } from "@/lib/types";
import { isActionComplete, isTriggerComplete } from "@/lib/types";

/* ─────────────────────────────────────────────────────────────────────
   /api/automations — single integration boundary for the keeper bot.
   Today: validates the body and stores it in a module-scope Map.
   When NEXT_PUBLIC_KEEPER_URL is set, also forwards the JSON.
   The keeper consumes this route once it ships.
   ───────────────────────────────────────────────────────────────────── */

const STORE = new Map<string, Automation>();

const KEEPER_URL = process.env.NEXT_PUBLIC_KEEPER_URL || null;

function validateAutomation(body: unknown): Automation | string {
  if (!body || typeof body !== "object") return "body must be an object";
  const a = body as Partial<Automation>;
  if (a.schemaVersion !== 2) return "schemaVersion must be 2";
  if (typeof a.id !== "string" || !a.id) return "id required";
  if (!Array.isArray(a.triggers) || a.triggers.length === 0) return "triggers required";
  if (!Array.isArray(a.actions) || a.actions.length === 0) return "actions required";
  for (const t of a.triggers) {
    if (!isTriggerComplete(t)) return `incomplete trigger: ${JSON.stringify(t)}`;
  }
  for (const ac of a.actions) {
    if (!isActionComplete(ac)) return `incomplete action: ${JSON.stringify(ac)}`;
  }
  const tOps = Array.isArray(a.triggerOperators) ? a.triggerOperators : [];
  const aOps = Array.isArray(a.actionOperators) ? a.actionOperators : [];
  if (tOps.length !== a.triggers.length - 1) {
    return `triggerOperators length must be ${a.triggers.length - 1}`;
  }
  if (aOps.length !== a.actions.length - 1) {
    return `actionOperators length must be ${a.actions.length - 1}`;
  }
  for (const op of tOps) {
    if (op !== "and" && op !== "or") return `invalid trigger operator: ${op}`;
  }
  for (const op of aOps) {
    if (op !== "then" && op !== "and") return `invalid action operator: ${op}`;
  }
  return body as Automation;
}

async function forwardToKeeper(auto: Automation): Promise<boolean> {
  if (!KEEPER_URL) return false;
  try {
    const res = await fetch(KEEPER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auto),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const validated = validateAutomation(body);
  if (typeof validated === "string") {
    return NextResponse.json({ error: validated }, { status: 400 });
  }
  STORE.set(validated.id, validated);
  const forwardedToKeeper = await forwardToKeeper(validated);
  return NextResponse.json({
    id: validated.id,
    status: "pending",
    forwardedToKeeper,
  });
}

export async function GET() {
  return NextResponse.json({
    items: Array.from(STORE.values()),
    keeperConfigured: Boolean(KEEPER_URL),
  });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const existed = STORE.delete(id);
  return NextResponse.json({ deleted: existed });
}
