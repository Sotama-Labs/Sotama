import type http from "node:http";
import { latestHeartbeat } from "@sotama/db";
import type { HealthResponseDto, SchedulerTelemetryDto } from "@sotama/market-core";
import { sendJson } from "../http";
import { HEARTBEAT_STALE_MS } from "../constants";
import { toHeartbeatDto } from "../builders/heartbeat";

export async function handleHealth(
  res: http.ServerResponse,
  schedulerTelemetry: SchedulerTelemetryDto | null,
): Promise<void> {
  const hb = await latestHeartbeat();
  const ageMs = hb ? Date.now() - hb.observedAt.getTime() : null;
  const ok = ageMs != null && ageMs <= HEARTBEAT_STALE_MS;
  const body: HealthResponseDto = {
    ok,
    heartbeatAgeMs: ageMs,
    heartbeat: hb ? toHeartbeatDto(hb, schedulerTelemetry) : null,
  };
  sendJson(res, ok ? 200 : 503, body);
}
