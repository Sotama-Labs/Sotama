"use client";

import { useMemo, useState } from "react";
import type { Automation, Execution } from "@/lib/types";
import { isCompleted, isTerminal } from "@/lib/types";
import { CANONICAL_MINTS } from "@/lib/tokens";
import { fmt } from "@/lib/format";
import { AutomationRow } from "./SavedList";
import { ArrowRight, InfoCircle } from "./icons";

const SOL = CANONICAL_MINTS["So11111111111111111111111111111111111111112"];
const USDC = CANONICAL_MINTS["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];

const SAMPLE_AUTOMATIONS: Automation[] = [
  {
    id: "demo_1",
    schemaVersion: 2,
    triggers: [
      {
        kind: "token_price",
        token: SOL,
        quote: { kind: "usd" },
        comparator: "below",
        threshold: 180,
        oracle: {
          kind: "pyth",
          feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
          symbol: "Crypto.SOL/USD",
        },
      },
    ],
    triggerOperators: [],
    actions: [{ kind: "swap", inputToken: USDC, outputToken: SOL, amount: 250 }],
    actionOperators: [],
    running: true,
    runs: 3,
    lastCheck: "just now",
    createdAt: new Date().toISOString(),
  },
  {
    id: "demo_2",
    schemaVersion: 2,
    triggers: [
      {
        kind: "token_price",
        token: SOL,
        quote: { kind: "usd" },
        comparator: "above",
        threshold: 240,
        oracle: {
          kind: "pyth",
          feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
          symbol: "Crypto.SOL/USD",
        },
      },
    ],
    triggerOperators: [],
    actions: [{ kind: "swap", inputToken: SOL, outputToken: USDC, amount: 1.5 }],
    actionOperators: [],
    running: true,
    runs: 0,
    lastCheck: "12s ago",
    createdAt: new Date().toISOString(),
  },
  {
    id: "demo_3",
    schemaVersion: 2,
    triggers: [
      {
        kind: "staking_reward_amount",
        stakeAccount: "DemoStakeAccount111111111111111111111111111",
        threshold: 1,
      },
    ],
    triggerOperators: [],
    actions: [
      {
        kind: "restake",
        stakeAccount: "DemoStakeAccount111111111111111111111111111",
        voteAccount: "DemoVoteAccount11111111111111111111111111111",
      },
    ],
    actionOperators: [],
    running: false,
    runs: 1,
    lastCheck: "2m ago",
    createdAt: new Date().toISOString(),
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

const NOOP = () => {};

export function ActiveStrategiesPage({
  automations,
  onToggle,
  onDelete,
}: {
  automations: Automation[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isDemo = automations.length === 0;
  const items = isDemo ? SAMPLE_AUTOMATIONS : automations;
  const exec = isDemo ? SAMPLE_EXECUTIONS : [];

  const running = useMemo(
    () => items.filter((a) => a.running && !isTerminal(a)),
    [items],
  );
  const completed = useMemo(() => items.filter((a) => isCompleted(a)), [items]);
  const paused = useMemo(
    () => items.filter((a) => !a.running && !isTerminal(a)),
    [items],
  );
  const toggle = isDemo ? NOOP : onToggle;
  const del = isDemo ? NOOP : onDelete;

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
          <InfoCircle />
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
                onToggle={toggle}
                onDelete={del}
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
                onToggle={toggle}
                onDelete={del}
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
                onToggle={toggle}
                onDelete={del}
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
