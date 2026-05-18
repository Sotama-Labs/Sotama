import { StatusPill } from "@sotama/ui";
import type { HeartbeatDto } from "@sotama/market-core";

export function BotHealthPill({ heartbeat }: { heartbeat: HeartbeatDto | null }) {
  if (!heartbeat) {
    return <StatusPill kind="bad">bot offline</StatusPill>;
  }
  const ageMs = Date.now() - new Date(heartbeat.observedAt).getTime();
  if (ageMs > 30_000) {
    return (
      <StatusPill kind="bad">bot stale ({Math.round(ageMs / 1000)}s)</StatusPill>
    );
  }
  if (heartbeat.http429Count1m > 0) {
    return (
      <StatusPill kind="warn">
        rate-limited · {heartbeat.activePairs} pairs · {heartbeat.currentRps.toFixed(1)} rps
      </StatusPill>
    );
  }
  if ((heartbeat.invalidFeedCount1m ?? 0) > 0) {
    return (
      <StatusPill kind="warn">
        stale Pyth · {heartbeat.invalidFeedCount1m} skipped
      </StatusPill>
    );
  }
  if (
    heartbeat.activeLazerEndpointCount != null &&
    heartbeat.activeLazerEndpointCount < 2
  ) {
    return (
      <StatusPill kind="warn">
        Lazer degraded · {heartbeat.activeLazerEndpointCount}/3
      </StatusPill>
    );
  }
  return (
    <StatusPill kind="ok">
      bot live · {heartbeat.activePairs} pairs
      {heartbeat.activeLazerEndpointCount == null
        ? ` · ${heartbeat.currentRps.toFixed(1)} rps`
        : ` · ${heartbeat.activeLazerEndpointCount}/3 Lazer`}
    </StatusPill>
  );
}
