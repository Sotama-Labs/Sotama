"use client";

import { Fragment, useState } from "react";
import type { Automation, Action, Trigger } from "@/lib/types";
import {
  renderActionSentence,
  renderTriggerSentence,
  shouldParenthesizeAction,
  shouldParenthesizeTrigger,
} from "./builder/SentenceRenderer";
import { Plus } from "./icons";

function AutomationRow({
  a,
  onToggle,
  onDelete,
  isLast,
}: {
  a: Automation;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  isLast: boolean;
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
        className={a.running ? "pulse-dot" : ""}
        style={{
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "0.25rem",
          background: a.running ? "var(--green)" : "var(--label-quaternary)",
          flexShrink: 0,
        }}
      />
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
          }}
        >
          <span style={{ color: "var(--label-secondary)" }}>If </span>
          {renderTriggers(a.triggers)}
          <span style={{ color: "var(--label-secondary)" }}> then </span>
          {renderActions(a.actions)}
        </div>
        <div className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.125rem" }}>
          {a.running ? `Running · last checked ${a.lastCheck}` : "Paused"}
          {a.runs > 0 && ` · ${a.runs} ${a.runs === 1 ? "execution" : "executions"}`}
        </div>
      </div>
      <button
        onClick={() => onDelete(a.id)}
        className="hig-footnote"
        style={{
          opacity: hover ? 1 : 0,
          transition: "opacity 120ms",
          padding: "0.25rem 0.5rem",
          fontWeight: 500,
          color: "var(--red)",
          borderRadius: "0.375rem",
        }}
      >
        Delete
      </button>
      <button
        onClick={() => onToggle(a.id)}
        role="switch"
        aria-checked={a.running}
        style={{
          width: "3.1875rem",
          height: "1.9375rem",
          background: a.running ? "var(--green)" : "var(--fill-1)",
          borderRadius: "999px",
          position: "relative",
          transition: "background 200ms",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "0.125rem",
            left: a.running ? 22 : 2,
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
          <AutomationRow key={a.id} a={a} onToggle={onToggle} onDelete={onDelete} isLast={i === items.length - 1} />
        ))}
      </div>
    </section>
  );
}

export { AutomationRow };
