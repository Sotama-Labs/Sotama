"use client";

import { useMemo, useState } from "react";
import type { Automation, Execution, Slot } from "@/lib/types";
import { fmt } from "@/lib/format";
import { AutomationRow } from "./SavedList";

const SAMPLE_AUTOMATIONS: Automation[] = [
  {
    id: "demo_1",
    triggers: [
      {
        choice: { id: "price_below", label: "SOL price drops below", needsValue: true, valueType: "price", unit: "USD" },
        value: 180,
      },
    ],
    actions: [
      {
        choice: { id: "swap_usdc_sol", label: "swap USDC to SOL", needsValue: true, valueType: "amount", unit: "USDC" },
        value: 250,
      },
    ],
    running: true,
    runs: 3,
    lastCheck: "just now",
  },
  {
    id: "demo_2",
    triggers: [
      {
        choice: { id: "price_above", label: "SOL price goes above", needsValue: true, valueType: "price", unit: "USD" },
        value: 240,
      },
    ],
    actions: [
      {
        choice: { id: "swap_sol_usdc", label: "swap SOL to USDC", needsValue: true, valueType: "amount", unit: "SOL" },
        value: 1.5,
      },
    ],
    running: true,
    runs: 0,
    lastCheck: "12s ago",
  },
  {
    id: "demo_3",
    triggers: [
      {
        choice: { id: "price_below", label: "SOL price drops below", needsValue: true, valueType: "price", unit: "USD" },
        value: 150,
      },
      {
        choice: { id: "price_above", label: "SOL price goes above", needsValue: true, valueType: "price", unit: "USD" },
        value: 100,
      },
    ],
    actions: [
      {
        choice: { id: "swap_usdc_sol", label: "swap USDC to SOL", needsValue: true, valueType: "amount", unit: "USDC" },
        value: 500,
      },
    ],
    running: false,
    runs: 1,
    lastCheck: "2m ago",
  },
];

const SAMPLE_EXECUTIONS: Execution[] = [
  { id: "x_001", strategyId: "demo_1", from: { token: "USDC", amount: 250 }, to: { token: "SOL", amount: 1.387 }, price: 180.24, when: "2h ago", txShort: "5g3K…hP9L" },
  { id: "x_002", strategyId: "demo_3", from: { token: "USDC", amount: 500 }, to: { token: "SOL", amount: 3.355 }, price: 149.02, when: "1d ago", txShort: "Bm7R…4xW2" },
  { id: "x_003", strategyId: "demo_1", from: { token: "USDC", amount: 250 }, to: { token: "SOL", amount: 1.401 }, price: 178.42, when: "3d ago", txShort: "9pQ2…tNc1" },
  { id: "x_004", strategyId: "demo_1", from: { token: "USDC", amount: 250 }, to: { token: "SOL", amount: 1.420 }, price: 176.05, when: "5d ago", txShort: "Hf8E…RdV6" },
];

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
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2.5 7 L11.5 7 M8 3.5 L11.5 7 L8 10.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
  executions,
  onToggle,
  onDelete,
}: {
  automations: Automation[];
  executions: Execution[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const items = automations.length > 0 ? automations : SAMPLE_AUTOMATIONS;
  const exec = executions.length > 0 ? executions : SAMPLE_EXECUTIONS;
  const isDemo = automations.length === 0;

  const running = useMemo(() => items.filter((a) => a.running), [items]);
  const paused = useMemo(() => items.filter((a) => !a.running), [items]);

  const noopToggle = () => {};
  const noopDelete = () => {};

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
      {isDemo && (
        <div
          style={{
            width: "100%",
            marginBottom: "1rem",
            padding: "0.625rem 0.875rem",
            background: "var(--accent-fill)",
            color: "var(--accent)",
            borderRadius: "0.625rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M7 4 V8 M7 10 V10.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="hig-footnote" style={{ fontWeight: 500 }}>
            Showing sample data. Compose a strategy to replace this view.
          </span>
        </div>
      )}

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
                onToggle={isDemo ? noopToggle : onToggle}
                onDelete={isDemo ? noopDelete : onDelete}
                isLast={i === running.length - 1}
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
                onToggle={isDemo ? noopToggle : onToggle}
                onDelete={isDemo ? noopDelete : onDelete}
                isLast={i === paused.length - 1}
              />
            ))}
          </div>
        </section>
      )}

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
    </div>
  );
}
