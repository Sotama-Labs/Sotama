"use client";

import { useMemo, useState } from "react";
import type { Automation, Execution } from "@/lib/types";
import { isCompleted, isTerminal } from "@/lib/types";
import { fmt } from "@/lib/format";
import { AutomationRow } from "./SavedList";
import { ArrowRight } from "./icons";

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
  executions,
  allCount,
}: {
  runningCount: number;
  executions: Execution[];
  allCount: number;
}) {
  const totalVol = executions.reduce((s, e) => s + (e.from?.amount || 0), 0);
  const totalSolBought = executions.filter((e) => e.to?.token === "SOL").reduce((s, e) => s + (e.to?.amount || 0), 0);

  const tiles = [
    { label: "Running", value: String(runningCount), sub: `${allCount} total` },
    { label: "Executions", value: String(executions.length), sub: "all time" },
    { label: "Volume", value: `$${fmt(totalVol, 2)}`, sub: `${fmt(totalSolBought, 3)} SOL` },
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
  const exec: Execution[] = [];

  const running = useMemo(
    () => items.filter((a) => a.running && !isTerminal(a)),
    [items],
  );
  const completed = useMemo(() => items.filter((a) => isCompleted(a)), [items]);
  const paused = useMemo(
    () => items.filter((a) => !a.running && !isTerminal(a)),
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
      <StatsStrip runningCount={running.length} executions={exec} allCount={items.length} />

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
