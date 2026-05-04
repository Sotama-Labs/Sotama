"use client";

import { createRef, useMemo, useRef, useState, type RefObject } from "react";
import type {
  Action,
  ActionOperator,
  Automation,
  ActionKind,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerKind,
  TriggerOperator,
} from "@/lib/types";
import { EMPTY_ACTION, EMPTY_TRIGGER } from "@/lib/types";
import {
  TRIGGER_CATEGORIES,
  type TriggerCategoryMeta,
  actionsAreCompatible,
  actionsForTriggers,
  findActionMeta,
  findTriggerCategoryForKind,
  findTriggerMeta,
} from "@/lib/catalog";
import { freezeActions, freezeTriggers } from "@/lib/automations";
import { Check } from "../icons";
import { Popover } from "./Popover";
import { PopoverList } from "./PopoverList";
import { SlotWithRemove } from "./SlotWithRemove";
import { AddButton } from "./AddButton";
import { OperatorChip } from "./OperatorChip";
import {
  renderActionContent,
  renderTriggerContent,
  shouldParenthesizeAction,
  shouldParenthesizeTrigger,
} from "./SentenceRenderer";

const TRIGGER_OPERATOR_OPTIONS = ["and", "or"] as const;
const ACTION_OPERATOR_OPTIONS = ["then", "and"] as const;
const DEFAULT_TRIGGER_OP: TriggerOperator = "and";
const DEFAULT_ACTION_OP: ActionOperator = "then";
import { TokenPriceEditor } from "./triggers/TokenPriceEditor";
import { AccountTransferEditor } from "./triggers/AccountTransferEditor";
import { AccountSwapEditor } from "./triggers/AccountSwapEditor";
import { StakingRewardAmountEditor } from "./triggers/StakingRewardAmountEditor";
import { StakingRewardTimeEditor } from "./triggers/StakingRewardTimeEditor";
import { TransferEditor } from "./actions/TransferEditor";
import { SwapEditor } from "./actions/SwapEditor";
import { RestakeEditor } from "./actions/RestakeEditor";
import { SellForEditor } from "./actions/SellForEditor";
import { TransferRewardEditor } from "./actions/TransferRewardEditor";

type Side = "if" | "then";
type Stage = "list" | "edit";

export type BuilderResult = {
  triggers: Trigger[];
  triggerOperators: TriggerOperator[];
  actions: Action[];
  actionOperators: ActionOperator[];
};

function seedTriggers(initial: Automation | null | undefined): DraftTrigger[] {
  if (initial?.triggers?.length) return initial.triggers as DraftTrigger[];
  return [{ ...EMPTY_TRIGGER }];
}

function seedActions(initial: Automation | null | undefined): DraftAction[] {
  if (initial?.actions?.length) return initial.actions as DraftAction[];
  return [{ ...EMPTY_ACTION }];
}

function seedTriggerOps(initial: Automation | null | undefined): TriggerOperator[] {
  if (initial?.triggerOperators?.length) return [...initial.triggerOperators];
  if (initial?.triggers?.length) {
    return Array(Math.max(0, initial.triggers.length - 1)).fill(DEFAULT_TRIGGER_OP);
  }
  return [];
}

function seedActionOps(initial: Automation | null | undefined): ActionOperator[] {
  if (initial?.actionOperators?.length) return [...initial.actionOperators];
  if (initial?.actions?.length) {
    return Array(Math.max(0, initial.actions.length - 1)).fill(DEFAULT_ACTION_OP);
  }
  return [];
}

function triggerReady(t: DraftTrigger): boolean {
  switch (t.kind) {
    case null:
      return false;
    case "token_price":
      return (
        t.token != null && t.threshold != null && t.threshold > 0 && t.oracle != null
      );
    case "account_transfer":
      return !!t.account && (t.token.mode === "any" || t.token.value != null);
    case "account_swap":
      return (
        !!t.account &&
        (t.token.mode === "any" || t.token.value != null) &&
        (t.amount.mode === "any" ||
          (t.amount.value != null && t.amount.value > 0))
      );
    case "staking_reward_amount":
      return t.threshold != null && t.threshold > 0;
    case "staking_reward_time":
      return t.intervalDays != null && t.intervalDays > 0;
  }
}

function actionReady(a: DraftAction): boolean {
  switch (a.kind) {
    case null:
      return false;
    case "transfer":
      return (
        a.token != null && a.amount != null && a.amount > 0 && !!a.destination
      );
    case "swap":
      return (
        a.inputToken != null &&
        a.outputToken != null &&
        a.amount != null &&
        a.amount > 0
      );
    case "restake":
      return true;
    case "sell_for":
      return a.outputToken != null;
    case "transfer_reward":
      return !!a.destination;
  }
}

export function ConditionalBuilder({
  initialState,
  onSave,
}: {
  initialState?: Automation | null;
  onSave: (data: BuilderResult) => void;
}) {
  const [triggers, setTriggers] = useState<DraftTrigger[]>(() => seedTriggers(initialState));
  const [actions, setActions] = useState<DraftAction[]>(() => seedActions(initialState));
  const [triggerOps, setTriggerOps] = useState<TriggerOperator[]>(() => seedTriggerOps(initialState));
  const [actionOps, setActionOps] = useState<ActionOperator[]>(() => seedActionOps(initialState));
  const [open, setOpen] = useState<{ side: Side; index: number } | null>(null);
  const [stage, setStage] = useState<Stage>("list");
  const [browsingCategory, setBrowsingCategory] = useState<TriggerCategoryMeta | null>(null);

  const refsRef = useRef<Record<string, RefObject<HTMLButtonElement>>>({});
  const refFor = (side: Side, idx: number): RefObject<HTMLButtonElement> => {
    const k = `${side}:${idx}`;
    if (!refsRef.current[k])
      refsRef.current[k] = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;
    return refsRef.current[k];
  };

  // Only completed triggers constrain the action menu — half-filled picks
  // shouldn't lock the user out of options before they've finished deciding.
  const completedTriggerKinds = useMemo(
    () => triggers.filter(triggerReady).map((t) => t.kind as TriggerKind),
    [triggers],
  );
  const availableActions = useMemo(
    () => actionsForTriggers(completedTriggerKinds),
    [completedTriggerKinds],
  );
  const anyTriggerKindPicked = triggers.some((t) => t.kind != null);

  const allActionsCompatible = actionsAreCompatible(
    completedTriggerKinds,
    actions
      .filter((a): a is DraftAction & { kind: ActionKind } => a.kind != null)
      .map((a) => a.kind as ActionKind),
  );
  const ready =
    triggers.length > 0 &&
    actions.length > 0 &&
    triggers.every(triggerReady) &&
    actions.every(actionReady) &&
    allActionsCompatible;

  const closePopover = () => {
    setOpen(null);
    setStage("list");
    setBrowsingCategory(null);
  };

  const openSlot = (side: Side, idx: number) => {
    const arr = side === "if" ? triggers : actions;
    const cur = arr[idx];
    setOpen({ side, index: idx });
    setBrowsingCategory(null);
    // Defensive: a freshly-added slot may not be visible to this closure yet.
    if (!cur || cur.kind == null) {
      setStage("list");
    } else {
      setStage("edit");
    }
  };

  const updateTriggerAt = (idx: number, next: DraftTrigger) =>
    setTriggers((prev) => prev.map((t, i) => (i === idx ? next : t)));
  const updateActionAt = (idx: number, next: DraftAction) =>
    setActions((prev) => prev.map((a, i) => (i === idx ? next : a)));

  const pickTriggerKind = (idx: number, kind: TriggerKind) => {
    const meta = findTriggerMeta(kind);
    if (!meta) return;
    const empty = meta.empty();
    setTriggers((prev) => prev.map((t, i) => (i === idx ? empty : t)));
    setStage("edit");
    setBrowsingCategory(null);
    // No action reset — incompatibilities are surfaced by the disabled save
    // button and the "Available actions" hint pill, so the user keeps any
    // existing actions that still fit the new trigger set and can re-pick
    // anything that doesn't.
  };

  const pickTriggerCategory = (idx: number, category: TriggerCategoryMeta) => {
    if (category.kinds.length === 1) {
      pickTriggerKind(idx, category.kinds[0].kind);
      return;
    }
    setBrowsingCategory(category);
  };

  const goBackFromEditor = (side: Side, idx: number) => {
    if (side === "then") {
      setStage("list");
      return;
    }
    const cur = triggers[idx];
    const cat = cur.kind != null ? findTriggerCategoryForKind(cur.kind) : null;
    if (cat && cat.kinds.length > 1) {
      setBrowsingCategory(cat);
    } else {
      setBrowsingCategory(null);
    }
    setStage("list");
  };

  const pickActionKind = (idx: number, kind: ActionKind) => {
    const meta = findActionMeta(kind);
    if (!meta) return;
    setActions((prev) => prev.map((a, i) => (i === idx ? meta.empty() : a)));
    setStage("edit");
  };

  const addTrigger = () => {
    const newIndex = triggers.length;
    setTriggers((prev) => [...prev, { ...EMPTY_TRIGGER }]);
    // Append a default operator for the new boundary between the previous
    // last slot and the freshly-added one.
    setTriggerOps((prev) => [...prev, DEFAULT_TRIGGER_OP]);
    setOpen({ side: "if", index: newIndex });
    setStage("list");
    setBrowsingCategory(null);
  };
  const addAction = () => {
    const newIndex = actions.length;
    setActions((prev) => [...prev, { ...EMPTY_ACTION }]);
    setActionOps((prev) => [...prev, DEFAULT_ACTION_OP]);
    setOpen({ side: "then", index: newIndex });
    setStage("list");
    setBrowsingCategory(null);
  };

  const removeSlot = (side: Side, idx: number) => {
    if (side === "if") {
      setTriggers((prev) =>
        prev.length === 1 ? [{ ...EMPTY_TRIGGER }] : prev.filter((_, i) => i !== idx),
      );
      setTriggerOps((prev) => {
        if (prev.length === 0) return prev;
        const opIdx = idx === 0 ? 0 : idx - 1;
        return prev.filter((_, i) => i !== opIdx);
      });
    } else {
      setActions((prev) =>
        prev.length === 1 ? [{ ...EMPTY_ACTION }] : prev.filter((_, i) => i !== idx),
      );
      setActionOps((prev) => {
        if (prev.length === 0) return prev;
        const opIdx = idx === 0 ? 0 : idx - 1;
        return prev.filter((_, i) => i !== opIdx);
      });
    }
    if (open && open.side === side && open.index === idx) closePopover();
  };

  const setTriggerOp = (idx: number, op: TriggerOperator) =>
    setTriggerOps((prev) => prev.map((o, i) => (i === idx ? op : o)));
  const setActionOp = (idx: number, op: ActionOperator) =>
    setActionOps((prev) => prev.map((o, i) => (i === idx ? op : o)));

  const handleSave = () => {
    const t = freezeTriggers(triggers);
    const a = freezeActions(actions);
    if (!t || !a) return;
    onSave({
      triggers: t,
      triggerOperators: triggerOps,
      actions: a,
      actionOperators: actionOps,
    });
  };

  const renderEditor = () => {
    if (!open) return null;
    if (open.side === "if") {
      const t = triggers[open.index];
      const onBack = () => goBackFromEditor("if", open.index);
      const onConfirm = () => closePopover();
      switch (t.kind) {
        case "token_price":
          return (
            <TokenPriceEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "account_transfer":
          return (
            <AccountTransferEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "account_swap":
          return (
            <AccountSwapEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "staking_reward_amount":
          return (
            <StakingRewardAmountEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "staking_reward_time":
          return (
            <StakingRewardTimeEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case null:
          return null;
      }
    } else {
      const a = actions[open.index];
      const onBack = () => goBackFromEditor("then", open.index);
      const onConfirm = () => closePopover();
      switch (a.kind) {
        case "transfer":
          return (
            <TransferEditor
              draft={a}
              onChange={(next) => updateActionAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "swap":
          return (
            <SwapEditor
              draft={a}
              onChange={(next) => updateActionAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "restake":
          return <RestakeEditor onBack={onBack} onConfirm={onConfirm} />;
        case "sell_for":
          return (
            <SellForEditor
              draft={a}
              onChange={(next) => updateActionAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "transfer_reward":
          return (
            <TransferRewardEditor
              draft={a}
              onChange={(next) => updateActionAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case null:
          return null;
      }
    }
  };

  const popoverContent = (() => {
    if (!open) return null;

    let body: React.ReactNode;

    if (stage === "edit") {
      body = renderEditor();
    } else if (open.side === "if") {
      const cur = triggers[open.index];
      if (browsingCategory) {
        body = (
          <PopoverList
            title={browsingCategory.label}
            options={browsingCategory.kinds}
            selectedKind={cur?.kind ?? null}
            onPick={(o) => pickTriggerKind(open.index, o.kind)}
            onBack={() => setBrowsingCategory(null)}
          />
        );
      } else {
        const currentCategoryId =
          cur?.kind != null
            ? findTriggerCategoryForKind(cur.kind as TriggerKind)?.id ?? null
            : null;
        body = (
          <PopoverList
            title="When this happens"
            options={TRIGGER_CATEGORIES.map((c) => ({
              kind: c.id,
              label: c.label,
              description: c.description,
            }))}
            selectedKind={currentCategoryId}
            onPick={(o) => {
              const cat = TRIGGER_CATEGORIES.find((c) => c.id === o.kind);
              if (cat) pickTriggerCategory(open.index, cat);
            }}
          />
        );
      }
    } else if (!anyTriggerKindPicked) {
      body = (
        <div className="fade-slide" style={{ padding: "0.875rem 1rem" }}>
          <p
            className="hig-footnote"
            style={{ color: "var(--label-secondary)", margin: 0 }}
          >
            Choose a trigger first to see which actions apply.
          </p>
        </div>
      );
    } else {
      body = (
        <PopoverList
          title="Do this"
          options={availableActions}
          selectedKind={actions[open.index]?.kind ?? null}
          onPick={(o) => pickActionKind(open.index, o.kind as ActionKind)}
        />
      );
    }

    return (
      <Popover
        anchorRef={refFor(open.side, open.index)}
        open={true}
        onClose={closePopover}
        width={420}
        align="start"
      >
        {body}
      </Popover>
    );
  })();

  const renderChain = (
    side: Side,
    slots: Array<DraftTrigger | DraftAction>,
    leadWord: string,
    placeholder: string,
  ) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: "0.625rem",
        columnGap: "0.5rem",
      }}
    >
      <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>{leadWord}</span>
      {slots.map((slot, i) => {
        const isOpen = !!(open && open.side === side && open.index === i);
        const isReady = side === "if"
          ? triggerReady(slot as DraftTrigger)
          : actionReady(slot as DraftAction);
        const content = side === "if"
          ? renderTriggerContent(slot as DraftTrigger)
          : renderActionContent(slot as DraftAction);

        const opBefore: TriggerOperator | ActionOperator | null = i > 0
          ? side === "if"
            ? triggerOps[i - 1] ?? DEFAULT_TRIGGER_OP
            : actionOps[i - 1] ?? DEFAULT_ACTION_OP
          : null;
        const paren = side === "if"
          ? shouldParenthesizeTrigger(opBefore as TriggerOperator | null)
          : shouldParenthesizeAction(opBefore as ActionOperator | null);

        return (
          <span
            key={`${side}-${i}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            {i > 0 && opBefore && (
              side === "if" ? (
                <OperatorChip
                  value={opBefore as TriggerOperator}
                  options={TRIGGER_OPERATOR_OPTIONS}
                  onChange={(next) => setTriggerOp(i - 1, next)}
                />
              ) : (
                <OperatorChip
                  value={opBefore as ActionOperator}
                  options={ACTION_OPERATOR_OPTIONS}
                  onChange={(next) => setActionOp(i - 1, next)}
                />
              )
            )}
            {paren && (
              <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>(</span>
            )}
            <SlotWithRemove
              slotRef={refFor(side, i)}
              active={isOpen}
              hasValue={isReady}
              content={content}
              placeholder={placeholder}
              showRemove={slots.length > 1}
              onClick={() => (isOpen ? closePopover() : openSlot(side, i))}
              onRemove={() => removeSlot(side, i)}
            />
            {paren && (
              <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>)</span>
            )}
          </span>
        );
      })}
      <AddButton
        onClick={() => (side === "if" ? addTrigger() : addAction())}
        aria-label={`Add another ${side === "if" ? "trigger" : "action"}`}
      />
    </span>
  );

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "45rem",
        background: "var(--bg-system)",
        border: "0.5px solid var(--separator)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-2)",
        padding: "2rem 2.25rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            rowGap: "0.75rem",
            columnGap: "0.625rem",
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--hig-font-display)",
            fontSize: "1.5rem",
            lineHeight: "2rem",
            fontWeight: 600,
            letterSpacing: "0.012em",
            color: "var(--label-primary)",
          }}
        >
          {renderChain("if", triggers, "If", "choose a trigger")}
          {renderChain("then", actions, "then", "choose an action")}
        </div>
        <button
          disabled={!ready}
          onClick={handleSave}
          aria-label="Save automation"
          title={ready ? "Save & run" : "Complete all slots first"}
          style={{
            width: "2.75rem",
            height: "2.75rem",
            flexShrink: 0,
            borderRadius: "999px",
            background: ready ? "var(--accent)" : "var(--fill-3)",
            color: ready ? "white" : "var(--label-tertiary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 160ms, transform 160ms",
            cursor: ready ? "pointer" : "not-allowed",
            boxShadow: ready ? "0 1px 2px rgba(0,0,0,0.10)" : "none",
          }}
          onMouseEnter={(e) => {
            if (ready) (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.06)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
          }}
        >
          <Check size={20} strokeWidth={2} />
        </button>
      </div>

      {/* Generic hint pill — surfaces the current action menu once any
          trigger kind has been picked. Mirrors what the picker shows so
          users know which actions are valid before opening it. */}
      {anyTriggerKindPicked && (
        <div
          className="hig-caption-1"
          style={{
            marginTop: "0.75rem",
            color: "var(--label-tertiary)",
            padding: "0 0.125rem",
          }}
        >
          {availableActions.length === 0
            ? "No actions are compatible with the chosen triggers."
            : `Available actions: ${availableActions.map((a) => a.label).join(", ")}.`}
        </div>
      )}

      {popoverContent}
    </div>
  );
}
