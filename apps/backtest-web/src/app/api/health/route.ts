import { NextResponse } from "next/server";
import { fetchHealth } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await fetchHealth();
    return NextResponse.json(health, { status: health.ok ? 200 : 503 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 502 },
    );
  }
}
