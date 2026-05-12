"use client";

import { useMemo, useState } from "react";
import type { Automation, Execution } from "@/lib/types";
import { isClosed, isCompleted, isTerminal } from "@/lib/types";
import { fmt } from "@/lib/format";
import { AutomationRow } from "./SavedList";
import { ArrowRight } from "./icons";
import { useAutomationFills } from "@/hooks/useAutomationFills";
import { useUsdPrices } from "@/hooks/useUsdPrices";

function SectionHeader({ title, count, trailing }: { title: string; count?: number; trailing?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 1rem 0.5rem" }}>
      <h2
        className="hig-footnote"
        style={{
          margin: 0,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontWeight: 600,
          color: "var(--label-secondary)",
        }}
      >
        {title}
        {count != null && <span style={{ color: "var(--label-tertiary)", marginLeft: "0.375rem" }}>· {count}</span>}
      </h2>
      {trailing}
    </div>
  );
}

function StatsStrip({
  runningCount,
  executionsCount,
  volumeUsd,
  hasFills,
  allCount,
}: {
  runningCount: number;
  /** Sum of `Automation.runs` across all loaded automations. Driven by
   *  the on-chain sync hook, so it's accurate even before the
   *  fills-from-logs cache has finished hydrating. */
  executionsCount: number;
  /** Sum over decoded `AutomationFilled` events of
   *  `(input_amount / 10^decimals) × usd-per-input-mint`. Independent
   *  of `executionsCount` so the dashboard can show counts immediately
   *  while volume converges. */
  volumeUsd: number;
  /** Whether we have at least one decoded fill yet. Drives `$0.00`
   *  vs `—` in the Volume tile so an empty cache doesn't render a
   *  misleading zero. */
  hasFills: boolean;
  allCount: number;
}) {
  const volumeDisplay = hasFills ? `$${fmt(volumeUsd, 2)}` : "—";
  const tiles = [
    { label: "Running", value: String(runningCount), sub: `${allCount} total` },
    { label: "Executions", value: String(executionsCount), sub: "all time" },
    {
      label: "Volume",
      value: volumeDisplay,
      sub: hasFills ? "lifetime input" : "loading…",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "0.75rem",
        width: "100%",
        maxWidth: "45rem",
        marginBottom: "1.5rem",
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.label}
          style={{
            background: "var(--bg-system)",
            border: "0.5px solid var(--separator)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-1)",
            padding: "0.875rem 1rem",
          }}
        >
          <div
            className="hig-caption-2"
            style={{
              color: "var(--label-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontWeight: 600,
              marginBottom: "0.25rem",
            }}
          >
            {t.label}
          </div>
          <div
            className="hig-title-2"
            style={{
              color: "var(--label-primary)",
              fontFeatureSettings: '"tnum"',
              fontWeight: 600,
              letterSpacing: "0.012em",
            }}
          >
            {t.value}
          </div>
          <div className="hig-caption-1" style={{ color: "var(--label-tertiary)", marginTop: "0.125rem" }}>
            {t.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function ExecutionRow({ e, isLast }: { e: Execution; isLast: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.75rem 1rem",
        borderBottom: isLast ? "none" : "0.5px solid var(--separator)",
        background: hover ? "var(--fill-4)" : "transparent",
        transition: "background 80ms",
      }}
    >
      <span
        style={{
          width: "1.75rem",
          height: "1.75rem",
          flexShrink: 0,
          borderRadius: "999px",
          background: "var(--accent-fill)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ArrowRight />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className="hig-subheadline"
          style={{
            fontWeight: 500,
            color: "var(--label-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Swapped <span style={{ fontFeatureSettings: '"tnum"' }}>{fmt(e.from.amount, 4)} {e.from.token}</span>
          <span style={{ color: "var(--label-secondary)" }}> for </span>
          <span style={{ fontFeatureSettings: '"tnum"' }}>{fmt(e.to.amount, 4)} {e.to.token}</span>
        </div>
        <div
          className="hig-footnote"
          style={{ color: "var(--label-secondary)", marginTop: "0.125rem", fontFeatureSettings: '"tnum"' }}
        >
          @ ${fmt(e.price, 2)} · {e.when} · {e.txShort}
        </div>
      </div>
      <button
        className="hig-footnote"
        style={{
          opacity: hover ? 1 : 0,
          transition: "opacity 120ms",
          padding: "0.25rem 0.5rem",
          fontWeight: 500,
          color: "var(--accent)",
          borderRadius: "0.375rem",
          flexShrink: 0,
        }}
      >
        View
      </button>
    </div>
  );
}

export function ActiveStrategiesPage({
  automations,
  onToggle,
  onDelete,
}: {
  automations: Automation[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const items = automations;
  // Placeholder for the "Recent executions" panel — populating this from
  // decoded fills is a follow-up (needs token-symbol + tx-explorer link
  // derivation per fill). Stats above use the raw fills + a.runs.
  const exec: Execution[] = [];

  // Lookup index used while aggregating volume: each decoded fill carries
  // an automation pubkey, but the input mint + decimals live on the
  // Automation record (the action slot the user picked at create time).
  const automationByPda = useMemo(() => {
    const map = new Map<string, Automation>();
    for (const a of items) {
      if (a.pubkey) map.set(a.pubkey, a);
    }
    return map;
  }, [items]);

  // Torch-passing model for chain status. At any point in a chain
  // (finite cascade OR perpetual loop) exactly one rule holds the
  // "torch": its input ATA has the previous rule's output (or, at
  // cold start, the seed deposit). Every other rule's input ATA is
  // empty — the keeper's executor would silently bail with
  // `SkipEmptyUpstreamATA` if their trigger condition matched. Those
  // non-torch rules show as "Waiting on upstream" with a grey dot
  // instead of the green pulse.
  //
  // Derivation from local state alone (no extra RPC):
  //   • Group rules by `link.chainId`, sort by `link.position`.
  //   • Let `maxRuns` = max of `runs` across the chain. Torch holder
  //     is the smallest position whose `runs < maxRuns`. If every rule
  //     has the same `runs` (cold start OR a loop cycle just closed),
  //     the torch is at the head (position 0).
  //
  // Why this works for loops: every completed cycle increments every
  // rule's `runs` by exactly 1, so within an in-progress cycle the
  // positions before the torch are at `cycle+1` and the positions
  // at-and-after are at `cycle`. The boundary is exactly the torch.
  //
  // Why it works for finite cascades: same algorithm. After the tail
  // fires, every rule sits at `runs = 1`, so the all-equal branch
  // points at position 0 — but those rules are already terminal and
  // the `AutomationRow` guard (`waiting && a.running && !terminal`)
  // filters the flag out.
  //
  // Latency: `runs` is patched by `useOnChainAutomationSync` every
  // 10s, so the torch position can lag reality by up to one poll
  // interval after a fire lands. Acceptable for a status indicator.
  const waitingIds = useMemo(() => {
    const chainGroups = new Map<string, Automation[]>();
    for (const a of items) {
      if (!a.link) continue;
      const arr = chainGroups.get(a.link.chainId) ?? [];
      arr.push(a);
      chainGroups.set(a.link.chainId, arr);
    }
    const waiting = new Set<string>();
    for (const fullChain of chainGroups.values()) {
      // Exclude terminal rules from the torch calculation. Their `runs`
      // is frozen and they don't fire again — e.g. a warm-up rule at
      // position 0 of a `[warm-up, loopA, loopB]` chain is `Cadence::Once`
      // and goes terminal after its first fire; including it in the
      // all-equal check would put the torch on the dead warm-up forever.
      const live = fullChain.filter((a) => !isTerminal(a));
      if (live.length <= 1) continue;
      live.sort(
        (l, r) => (l.link?.position ?? 0) - (r.link?.position ?? 0),
      );
      const runsArr = live.map((c) => c.runs || 0);
      const maxRuns = Math.max(...runsArr);
      const allEqual = runsArr.every((r) => r === maxRuns);
      const torchIdx = allEqual ? 0 : runsArr.findIndex((r) => r < maxRuns);
      for (let i = 0; i < live.length; i++) {
        if (i !== torchIdx) waiting.add(live[i].id);
      }
    }
    return waiting;
  }, [items]);

  const fills = useAutomationFills(items);

  // Union of input mints across owned automations — only ask Jupiter
  // about mints we actually need a price for.
  const inputMints = useMemo(() => {
    const set = new Set<string>();
    for (const a of items) {
      const act = a.actions[0];
      if (!act) continue;
      if (act.kind === "swap") set.add(act.inputToken.mint);
      else if (act.kind === "transfer") set.add(act.token.mint);
    }
    return Array.from(set);
  }, [items]);

  const prices = useUsdPrices(inputMints);

  const executionsCount = useMemo(
    () => items.reduce((s, a) => s + (a.runs || 0), 0),
    [items],
  );

  // Volume = Σ over decoded fills of (input_amount / 10^decimals) × USD.
  // Fills whose automation isn't in local state (e.g. removed locally
  // via "Remove") or whose input mint Jupiter doesn't price are skipped
  // — better to undercount than to render a misleading number.
  const volumeUsd = useMemo(() => {
    let total = 0;
    for (const f of fills) {
      const a = automationByPda.get(f.automation);
      if (!a) continue;
      const act = a.actions[0];
      if (!act) continue;
      let mint: string;
      let decimals: number;
      if (act.kind === "swap") {
        mint = act.inputToken.mint;
        decimals = act.inputToken.decimals;
      } else if (act.kind === "transfer") {
        mint = act.token.mint;
        decimals = act.token.decimals;
      } else {
        continue;
      }
      const usd = prices[mint];
      if (!usd) continue;
      const native = Number(f.inputAmount) / Math.pow(10, decimals);
      if (!Number.isFinite(native)) continue;
      total += native * usd;
    }
    return total;
  }, [fills, automationByPda, prices]);

  const running = useMemo(
    () => items.filter((a) => a.running && !isTerminal(a)),
    [items],
  );
  const completed = useMemo(() => items.filter((a) => isCompleted(a)), [items]);
  // Closed-without-executed: user cancelled before the rule ever fired
  // (closedAt set, executedAt unset). Without this section those rows
  // would not appear in any of the other filters and the "Close & collect"
  // / cancel action would feel like it erased the rule entirely.
  const closedOnly = useMemo(
    () => items.filter((a) => isClosed(a) && !isCompleted(a)),
    [items],
  );
  const paused = useMemo(
    () => items.filter((a) => !a.running && !isTerminal(a)),
    [items],
  );
  // Single signal driving PdaHoldings re-fetch — see SavedList for the
  // rationale (catches upstream-chain fires that credit downstream PDAs).
  const refreshKey = useMemo(
    () =>
      items.reduce(
        (s, a) => s + (a.runs || 0) + (a.closedAt ? 1 : 0),
        0,
      ),
    [items],
  );

  if (items.length === 0) {
    return (
      <div
        className="fade-slide"
        style={{
          width: "100%",
          maxWidth: "45rem",
          marginTop: "1.25rem",
          padding: "3rem 1.5rem",
          background: "var(--bg-system)",
          border: "0.5px solid var(--separator)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-1)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.5rem",
          textAlign: "center",
        }}
      >
        <div
          className="hig-headline"
          style={{ color: "var(--label-primary)", fontWeight: 600 }}
        >
          No automations yet
        </div>
        <div
          className="hig-subheadline"
          style={{ color: "var(--label-secondary)", maxWidth: "28rem" }}
        >
          Compose an automation first — saved strategies will appear here once
          they&rsquo;re funded on-chain.
        </div>
      </div>
    );
  }

  return (
    <div
      className="fade-slide"
      style={{
        width: "100%",
        maxWidth: "45rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        marginTop: "1.25rem",
      }}
    >
      <StatsStrip
        runningCount={running.length}
        executionsCount={executionsCount}
        volumeUsd={volumeUsd}
        hasFills={fills.length > 0}
        allCount={items.length}
      />

      {running.length > 0 && (
        <section style={{ width: "100%", marginBottom: "1.5rem" }}>
          <SectionHeader title="Running" count={running.length} />
          <div
            style={{
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-1)",
              overflow: "hidden",
            }}
          >
            {running.map((a, i) => (
              <AutomationRow
                key={a.id}
                a={a}
                onToggle={onToggle}
                onDelete={onDelete}
                isLast={i === running.length - 1}
                refreshKey={refreshKey}
                waitingOnUpstream={waitingIds.has(a.id)}
              />
            ))}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section style={{ width: "100%", marginBottom: "1.5rem" }}>
          <SectionHeader title="Completed" count={completed.length} />
          <div
            style={{
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-1)",
              overflow: "hidden",
            }}
          >
            {completed.map((a, i) => (
              <AutomationRow
                key={a.id}
                a={a}
                onToggle={onToggle}
                onDelete={onDelete}
                isLast={i === completed.length - 1}
                refreshKey={refreshKey}
              />
            ))}
          </div>
        </section>
      )}

      {closedOnly.length > 0 && (
        <section style={{ width: "100%", marginBottom: "1.5rem" }}>
          <SectionHeader title="Closed" count={closedOnly.length} />
          <div
            style={{
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-1)",
              overflow: "hidden",
            }}
          >
            {closedOnly.map((a, i) => (
              <AutomationRow
                key={a.id}
                a={a}
                onToggle={onToggle}
                onDelete={onDelete}
                isLast={i === closedOnly.length - 1}
                refreshKey={refreshKey}
              />
            ))}
          </div>
        </section>
      )}

      {paused.length > 0 && (
        <section style={{ width: "100%", marginBottom: "1.5rem" }}>
          <SectionHeader title="Paused" count={paused.length} />
          <div
            style={{
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-1)",
              overflow: "hidden",
            }}
          >
            {paused.map((a, i) => (
              <AutomationRow
                key={a.id}
                a={a}
                onToggle={onToggle}
                onDelete={onDelete}
                isLast={i === paused.length - 1}
                refreshKey={refreshKey}
                waitingOnUpstream={waitingIds.has(a.id)}
              />
            ))}
          </div>
        </section>
      )}

      {exec.length > 0 && (
        <section style={{ width: "100%" }}>
          <SectionHeader title="Recent executions" count={exec.length} />
          <div
            style={{
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-1)",
              overflow: "hidden",
            }}
          >
            {exec.map((e, i) => (
              <ExecutionRow key={e.id} e={e} isLast={i === exec.length - 1} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
