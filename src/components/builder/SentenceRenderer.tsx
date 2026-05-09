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
    case "account_swap":
      return (
        <>
          {renderAccount(t.account)} {muted("swaps")}{" "}
          {renderTokenSpec(t.token)} {muted("for")}{" "}
          {renderAmountSpec(
            t.amount,
            t.token.mode === "specific" ? t.token.value : null,
          )}
        </>
      );
    case "staking_reward_amount":
      return (
        <>
          {muted("staking reward exceeds")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {t.threshold != null ? `${t.threshold} SOL` : "…"}
          </span>
        </>
      );
    case "staking_reward_time":
      return (
        <>
          {muted("every")}{" "}
          <span style={{ fontFeatureSettings: '"tnum"' }}>
            {t.intervalDays != null
              ? `${t.intervalDays} ${t.intervalDays === 1 ? "day" : "days"}`
              : "…"}
          </span>{" "}
          {muted("of staking")}
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
            {a.amount != null ? formatTokenAmount(a.amount, a.inputToken) : "…"}
          </span>{" "}
          {a.inputToken ? <TokenPill token={a.inputToken} /> : muted("input")}{" "}
          {muted("for")}{" "}
          {a.outputToken ? <TokenPill token={a.outputToken} /> : muted("output")}
        </>
      );
    case "restake":
      return <>{muted("restake the reward")}</>;
    case "sell_for":
      return (
        <>
          {muted("sell reward for")}{" "}
          {a.outputToken ? <TokenPill token={a.outputToken} /> : muted("token")}
        </>
      );
    case "transfer_reward":
      return (
        <>
          {muted("transfer reward to")}{" "}
          <span style={{ fontFamily: "var(--hig-mono)" }}>
            {a.destination ? shortAddress(a.destination, 4) : "…"}
          </span>
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
