import { StatusPill } from "@sotama/ui";

export function BotHealthPill({
  heartbeat,
}: {
  heartbeat: {
    observedAt: string | null;
    activePairs: number;
    currentRps: number;
    http429Count1m: number;
  } | null;
}) {
  if (!heartbeat || !heartbeat.observedAt) {
    return <StatusPill kind="bad">bot offline</StatusPill>;
  }
  const ageMs = Date.now() - new Date(heartbeat.observedAt).getTime();
  if (ageMs > 30_000) {
    return <StatusPill kind="bad">bot stale ({Math.round(ageMs / 1000)}s)</StatusPill>;
  }
  if (heartbeat.http429Count1m > 0) {
    return (
      <StatusPill kind="warn">
        rate-limited · {heartbeat.activePairs} pairs · {heartbeat.currentRps.toFixed(1)} rps
      </StatusPill>
    );
  }
  return (
    <StatusPill kind="ok">
      bot live · {heartbeat.activePairs} pairs · {heartbeat.currentRps.toFixed(1)} rps
    </StatusPill>
  );
}
