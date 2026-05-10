"use client";

import { Fragment, type ReactNode } from "react";
import type {
  Action,
  ActionOperator,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerOperator,
  TokenRef,
  SpecificOrAny,
} from "@/lib/types";
import { formatTokenAmount, shortAddress } from "@/lib/format";
import { TokenPill } from "./TokenPill";

function renderAccount(addr: string | null | undefined): ReactNode {
  if (!addr) return muted("…");
  return (
    <span style={{ fontFamily: "var(--hig-mono)", fontWeight: 500 }}>
      {shortAddress(addr, 4)}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sentence rendering — each Trigger/Action becomes inline ReactNode
   content used inside a Slot. TokenPills render with logos so the
   sentence reads as natural English with icons inline.
   ───────────────────────────────────────────────────────────────────── */

const muted = (n: ReactNode) => (
  <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>{n}</span>
);

function renderTokenSpec(tok: SpecificOrAny<TokenRef> | SpecificOrAny<TokenRef | null>): ReactNode {
  if (tok.mode === "any") return muted("any token");
  if (tok.value == null) return muted("…");
  return <TokenPill token={tok.value} />;
}

function renderAmountSpec(
  amt: SpecificOrAny<number> | SpecificOrAny<number | null>,
  token: TokenRef | null,
): ReactNode {
  if (amt.mode === "any") return muted("any amount");
  if (amt.value == null) return muted("…");
  return (
    <span style={{ fontFeatureSettings: '"tnum"' }}>
      {formatTokenAmount(amt.value, token)}
      {token ? ` ${token.symbol}` : ""}
    </span>
  );
}

export function renderTriggerContent(t: DraftTrigger): ReactNode {
  switch (t.kind) {
    case null:
      return null;
    case "asset_price":
      return (
        <>
          {muted("price of")}{" "}
          {t.asset ? (
            <span style={{ fontWeight: 600, color: "var(--label-primary)" }}>
              {t.asset.displaySymbol}
            </span>
          ) : muted("…")}{" "}
          {muted(t.comparator === "below" ? "drops below" : "goes above")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {t.quote.kind === "usd"
              ? `$${t.threshold ?? "…"}`
              : `${t.threshold ?? "…"} ${t.quote.asset.displaySymbol}`}
          </span>
        </>
      );
    case "account_transfer":
      return (
        <>
          {renderAccount(t.account)} {muted("transfers")}{" "}
          {renderTokenSpec(t.token)}
        </>
      );
    case "account_swap": {
      const tokenForAmount =
        t.token.mode === "specific" ? t.token.value : null;
      // Three shapes:
      //   token any + amount any: "<addr> swaps any token"
      //   token specific + amount any: "<addr> swaps <token>"
      //   amount specific: "<addr> swaps at least|at most X <token>"
      if (t.amount.mode === "any") {
        return (
          <>
            {renderAccount(t.account)} {muted("swaps")}{" "}
            {renderTokenSpec(t.token)}
          </>
        );
      }
      const directionLabel =
        t.amountDirection === "at_most" ? "at most" : "at least";
      return (
        <>
          {renderAccount(t.account)} {muted("swaps")}{" "}
          {muted(directionLabel)}{" "}
          {renderAmountSpec(t.amount, tokenForAmount)}
          {t.token.mode === "any" ? (
            <>
              {" "}
              {muted("of any token")}
            </>
          ) : null}
        </>
      );
    }
    case "time_elapsed": {
      // "5 minutes have passed" / "0 minutes have passed" while empty.
      const v = t.value;
      const display = v == null ? muted("…") : (
        <span style={{ fontFeatureSettings: '"tnum"' }}>{v}</span>
      );
      // Simple plural: "1 minute" / "5 minutes". Singular only for v === 1.
      const unitLabel =
        v === 1
          ? t.unit.slice(0, -1) // "minutes" → "minute"
          : t.unit;
      return (
        <>
          {display} {muted(`${unitLabel} have passed`)}
        </>
      );
    }
    case "price_relative_to_fill":
      return (
        <>
          {muted("price")}{" "}
          {muted(t.direction === "grow" ? "grew" : "dropped")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {t.pctBps != null ? `${t.pctBps / 100}%` : muted("…")}
          </span>{" "}
          {muted("from upstream fill")}
        </>
      );
  }
}

export function renderActionContent(a: DraftAction): ReactNode {
  switch (a.kind) {
    case null:
      return null;
    case "transfer":
      return (
        <>
          {muted("transfer")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {a.amount != null ? formatTokenAmount(a.amount, a.token) : "…"}
          </span>{" "}
          {a.token ? <TokenPill token={a.token} /> : muted("token")}{" "}
          {muted("to")}{" "}
          <span style={{ fontFamily: "var(--hig-mono)" }}>
            {a.destination ? shortAddress(a.destination, 4) : "…"}
          </span>
        </>
      );
    case "swap":
      return (
        <>
          {muted("swap")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {a.consumeUpstreamOutput
              ? muted("upstream output")
              : a.amount != null
                ? formatTokenAmount(a.amount, a.inputToken)
                : "…"}
          </span>{" "}
          {a.inputToken ? <TokenPill token={a.inputToken} /> : muted("input")}{" "}
          {muted("for")}{" "}
          {a.outputToken ? <TokenPill token={a.outputToken} /> : muted("output")}
        </>
      );
  }
}

/** Frozen-trigger / frozen-action variant for SavedList & ActiveStrategiesPage. */
export function renderTriggerSentence(t: Trigger): ReactNode {
  return renderTriggerContent(t as DraftTrigger);
}

export function renderActionSentence(a: Action): ReactNode {
  return renderActionContent(a as DraftAction);
}

/** Should the slot at index `i` (0-based) be wrapped in parens? Driven by
 *  the operator immediately preceding it. Currently disabled for both —
 *  flip these returns to re-enable visual grouping (triggers on "or",
 *  actions on "and"). Call sites are already wired. */
export function shouldParenthesizeTrigger(_opBefore: TriggerOperator | null): boolean {
  return false;
}
export function shouldParenthesizeAction(_opBefore: ActionOperator | null): boolean {
  return false;
}

export function renderAutomationSentence(
  triggers: Trigger[],
  triggerOperators: TriggerOperator[],
  actions: Action[],
  actionOperators: ActionOperator[],
): ReactNode {
  return (
    <>
      {muted("If ")}
      {triggers.map((t, i) => {
        const opBefore = i > 0 ? triggerOperators[i - 1] ?? "and" : null;
        const paren = shouldParenthesizeTrigger(opBefore);
        return (
          <Fragment key={`t-${i}`}>
            {opBefore && muted(` ${opBefore} `)}
            {paren && muted("(")}
            {renderTriggerSentence(t)}
            {paren && muted(")")}
          </Fragment>
        );
      })}
      {muted(" then ")}
      {actions.map((a, i) => {
        const opBefore = i > 0 ? actionOperators[i - 1] ?? "then" : null;
        const paren = shouldParenthesizeAction(opBefore);
        return (
          <Fragment key={`a-${i}`}>
            {opBefore && muted(` ${opBefore} `)}
            {paren && muted("(")}
            {renderActionSentence(a)}
            {paren && muted(")")}
          </Fragment>
        );
      })}
    </>
  );
}
