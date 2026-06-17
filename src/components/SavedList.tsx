"use client";

import { Fragment, useEffect, useState } from "react";
import type { Automation, Action, Trigger } from "@/lib/types";
import { isClosed, isCompleted, isTerminal } from "@/lib/types";
import {
  renderActionSentence,
  renderTriggerSentence,
  shouldParenthesizeAction,
  shouldParenthesizeTrigger,
} from "./builder/SentenceRenderer";
import { Check, Plus } from "./icons";
import { PdaHoldings } from "./PdaHoldings";
import { isDemoMode } from "@/lib/demo/demo";

function AutomationRow({
  a,
  onToggle,
  onDelete,
  isLast,
  refreshKey,
  waitingOnUpstream = false,
}: {
  a: Automation;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  isLast: boolean;
  refreshKey: number;
  /** Chain downstream rule with `consume_upstream_output: true` whose
   *  upstream hasn't fired yet. The keeper is technically polling its
   *  trigger but every executor entry short-circuits via
   *  `SkipEmptyUpstreamATA` — surface that as a distinct visual state
   *  rather than the misleading green "Running" pulse. */
  waitingOnUpstream?: boolean;
}) {
  const [hover, setHover] = useState(false);

  const renderTriggers = (slots: Trigger[]) =>
    slots.map((t, i) => {
      const opBefore = i > 0 ? a.triggerOperators[i - 1] ?? "and" : null;
      const paren = shouldParenthesizeTrigger(opBefore);
      return (
        <Fragment key={`t${i}`}>
          {opBefore && (
            <span style={{ color: "var(--label-secondary)" }}> {opBefore} </span>
          )}
          {paren && <span style={{ color: "var(--label-secondary)" }}>(</span>}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
            {renderTriggerSentence(t)}
          </span>
          {paren && <span style={{ color: "var(--label-secondary)" }}>)</span>}
        </Fragment>
      );
    });

  const renderActions = (slots: Action[]) =>
    slots.map((act, i) => {
      const opBefore = i > 0 ? a.actionOperators[i - 1] ?? "then" : null;
      const paren = shouldParenthesizeAction(opBefore);
      return (
        <Fragment key={`a${i}`}>
          {opBefore && (
            <span style={{ color: "var(--label-secondary)" }}> {opBefore} </span>
          )}
          {paren && <span style={{ color: "var(--label-secondary)" }}>(</span>}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
            {renderActionSentence(act)}
          </span>
          {paren && <span style={{ color: "var(--label-secondary)" }}>)</span>}
        </Fragment>
      );
    });

  const completed = isCompleted(a);
  const closed = isClosed(a);
  const terminal = isTerminal(a);
  const link = a.link;
  const fundingError = link?.fundingError;

  // "Waiting on upstream" overrides the running treatment for chain
  // downstream rules whose upstream hasn't produced input yet — the
  // keeper will silently skip every trigger fire because the rule's
  // input ATA is empty, so calling it "Running · pulse" is dishonest.
  // Only meaningful when the rule isn't terminal and isn't paused.
  const waiting = waitingOnUpstream && a.running && !terminal && !fundingError;
  const now = useRelativeNow(Boolean(a.running || a.executedAt || a.closedAt));

  // Status copy + colors
  const dotColor = fundingError
    ? "var(--red)"
    : completed
    ? "var(--accent)"
    : closed
    ? "var(--label-quaternary)"
    : waiting
    ? "var(--label-tertiary)"
    : a.running
    ? "var(--green)"
    : "var(--label-quaternary)";

  const statusLine = fundingError
    ? `Auto-fund error · ${fundingError}`
    : completed
    ? `Completed${a.executedAt ? ` · fired ${formatTimeAgo(a.executedAt, now)}` : ""}`
    : closed
    ? `Closed${a.closedAt ? ` · refunded ${formatTimeAgo(a.closedAt, now)}` : ""}`
    : waiting
    ? "Waiting on upstream"
    : a.running
    ? `Running · last checked ${formatTimeAgo(a.lastCheck, now, a.createdAt)}`
    : "Paused";

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
        opacity: terminal ? 0.78 : 1,
      }}
    >
      {completed ? (
        <span
          aria-label="Completed"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "0.875rem",
            height: "0.875rem",
            borderRadius: "999px",
            background: "var(--accent)",
            color: "white",
            flexShrink: 0,
          }}
        >
          <Check size={9} />
        </span>
      ) : (
        <span
          className={a.running && !terminal && !waiting ? "pulse-dot" : ""}
          style={{
            width: "0.5rem",
            height: "0.5rem",
            borderRadius: "0.25rem",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className="hig-subheadline"
          style={{
            fontWeight: 500,
            color: "var(--label-primary)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.25rem",
            textDecoration: terminal ? "none" : undefined,
          }}
        >
          {link && (
            <span
              className="hig-caption-1"
              title={`Linked rule ${link.position + 1} of ${link.total}${link.next?.kind === "loopBack" ? " · loops" : ""}`}
              style={{
                padding: "0.125rem 0.4375rem",
                borderRadius: "999px",
                background: "var(--accent-fill)",
                color: "var(--accent)",
                fontWeight: 600,
                fontSize: "0.6875rem",
                letterSpacing: "0.02em",
                marginRight: "0.25rem",
                textTransform: "uppercase",
              }}
            >
              Chain {link.position + 1}/{link.total}
              {link.next?.kind === "loopBack" ? " ↻" : ""}
            </span>
          )}
          <span style={{ color: "var(--label-secondary)" }}>If </span>
          {renderTriggers(a.triggers)}
          <span style={{ color: "var(--label-secondary)" }}> then </span>
          {renderActions(a.actions)}
        </div>
        <div
          className="hig-footnote"
          style={{ color: "var(--label-secondary)", marginTop: "0.125rem", display: "flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}
        >
          <span>{statusLine}</span>
          {a.runs > 0 && (
            <span>· {a.runs} {a.runs === 1 ? "execution" : "executions"}</span>
          )}
          {a.pubkey && <PdaHoldings pda={a.pubkey} refreshKey={refreshKey} />}
          {a.pubkey && terminal && !isDemoMode() && (
            <a
              href={`https://orbmarkets.io/address/${a.pubkey}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              View on chain →
            </a>
          )}
        </div>
      </div>
      {/* Three button states for the delete/close action:
        * 1. completed + has-pubkey + not-yet-closed: explicit "Close & collect"
        *    that's always visible (not hover-gated) because the user has
        *    rent + ATA dust to reclaim. The actual on-chain close goes
        *    through onDelete → closeAutomationOnChain (drains PDA ATA to
        *    owner, ATA rent → owner, PDA rent → treasury).
        * 2. terminal-but-already-cleaned (closedAt set OR never on-chain):
        *    hover-only "Remove" — purely localStorage delete.
        * 3. active rule: hover-only "Delete" — cancels + refunds.
        */}
      {(() => {
        const needsClose = completed && a.pubkey && !a.closedAt;
        return (
          <button
            onClick={() => onDelete(a.id)}
            className="hig-footnote"
            style={{
              opacity: needsClose ? 1 : hover ? 1 : 0,
              transition: "opacity 120ms",
              padding: "0.25rem 0.5rem",
              fontWeight: 500,
              color: needsClose ? "var(--accent)" : "var(--red)",
              borderRadius: "0.375rem",
              border: needsClose ? "0.5px solid var(--accent)" : "none",
              whiteSpace: "nowrap",
            }}
            title={
              needsClose
                ? "Close on-chain: refunds remaining deposit + ATA rent to you, PDA rent (~0.003 SOL) to the treasury."
                : terminal
                ? "Remove from list (no on-chain action)"
                : "Cancel and refund the deposit"
            }
          >
            {needsClose ? "Close & collect" : terminal ? "Remove" : "Delete"}
          </button>
        );
      })()}
      <button
        onClick={() => {
          if (terminal) return;
          onToggle(a.id);
        }}
        disabled={terminal}
        aria-disabled={terminal || undefined}
        role="switch"
        aria-checked={a.running && !terminal}
        title={
          completed
            ? "This automation has already fired and cannot be resumed (single-shot)."
            : closed
            ? "This automation was closed on chain."
            : undefined
        }
        style={{
          width: "3.1875rem",
          height: "1.9375rem",
          background: terminal
            ? "var(--fill-2)"
            : a.running
            ? "var(--green)"
            : "var(--fill-1)",
          borderRadius: "999px",
          position: "relative",
          transition: "background 200ms",
          flexShrink: 0,
          cursor: terminal ? "not-allowed" : "pointer",
          opacity: terminal ? 0.5 : 1,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "0.125rem",
            left: a.running && !terminal ? 22 : 2,
            width: "1.6875rem",
            height: "1.6875rem",
            background: "white",
            borderRadius: "50%",
            boxShadow: "0 3px 8px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.1)",
            transition: "left 240ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        />
      </button>
    </div>
  );
}

function useRelativeNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    window.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);

  return now;
}

/** Compact relative time, e.g. "12s ago", "4m ago", "3h ago". */
function formatTimeAgo(iso: string, now = Date.now(), fallbackIso?: string): string {
  const parsed = Date.parse(iso);
  const fallback = fallbackIso ? Date.parse(fallbackIso) : NaN;
  const t = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(t)) return "0s ago";
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function SavedList({
  items,
  onToggle,
  onDelete,
  onNew,
}: {
  items: Automation[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  if (items.length === 0) return null;
  // Single signal that increments whenever the keeper executes any
  // automation OR an automation gets closed. Drives PdaHoldings
  // re-fetch — captures upstream-chain fires that credit downstream
  // PDAs' input ATAs without mutating their own Automation account.
  const refreshKey = items.reduce(
    (s, a) => s + (a.runs || 0) + (a.closedAt ? 1 : 0),
    0,
  );
  return (
    <section className="fade-slide" style={{ width: "100%", maxWidth: "45rem", marginTop: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 1rem 0.5rem",
        }}
      >
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
          Your automations · {items.length}
        </h2>
        <button
          onClick={onNew}
          className="hig-footnote"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding: "0.25rem 0.5rem",
            color: "var(--accent)",
            fontWeight: 500,
            borderRadius: "0.375rem",
          }}
        >
          <Plus size={11} /> New
        </button>
      </div>
      <div
        style={{
          background: "var(--bg-system)",
          border: "0.5px solid var(--separator)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-1)",
          overflow: "hidden",
        }}
      >
        {items.map((a, i) => (
          <AutomationRow key={a.id} a={a} onToggle={onToggle} onDelete={onDelete} isLast={i === items.length - 1} refreshKey={refreshKey} />
        ))}
      </div>
    </section>
  );
}

export { AutomationRow };
