import { NextResponse } from "next/server";
import { loadDashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snap = await loadDashboardSnapshot();
    return NextResponse.json(snap);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
