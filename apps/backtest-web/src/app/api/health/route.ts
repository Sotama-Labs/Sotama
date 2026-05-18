import { NextResponse } from "next/server";
import { latestHeartbeat } from "@sotama/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const hb = await latestHeartbeat();
    const ageMs = hb ? Date.now() - hb.observedAt.getTime() : null;
    const healthy = ageMs != null && ageMs <= 30_000;
    return NextResponse.json(
      {
        ok: healthy,
        heartbeatAgeMs: ageMs,
        heartbeat: hb
          ? {
              observedAt: hb.observedAt.toISOString(),
              activePairCount: hb.activePairCount,
              currentRps: hb.currentRps,
              http429Count1m: hb.http429Count1m,
              errorCount1m: hb.errorCount1m,
              streamLagMs: hb.streamLagMs,
              quoteLagMs: hb.quoteLagMs,
            }
          : null,
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
