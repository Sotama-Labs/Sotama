"use client";

import { createRef, useMemo, useRef, useState, type RefObject } from "react";
import type {
  Action,
  ActionOperator,
  Automation,
  ActionKind,
  Cadence,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerKind,
  TriggerOperator,
} from "@/lib/types";
import {
  DEFAULT_CADENCE,
  DEFAULT_INTERVAL_BY_CADENCE,
  DEFAULT_MIN_INTERVAL_SECS,
  EMPTY_ACTION,
  EMPTY_TRIGGER,
} from "@/lib/types";
import {
  type TriggerCategoryMeta,
  actionsAreCompatible,
  actionsForCadenceAndTriggers,
  findActionMeta,
  findTriggerCategoryForKind,
  findTriggerMeta,
  isActionKindAllowedForCadence,
  isTriggerKindAllowedForCadence,
  triggerCategoriesForCadence,
} from "@/lib/catalog";
import { freezeActions, freezeTriggers } from "@/lib/automations";
import {
  COMING_SOON_LABEL,
  isActionSupported,
  isTriggerCategorySupported,
  isTriggerSupported,
} from "@/lib/support";
import { Fragment } from "react";
import { Check } from "../icons";
import { Popover } from "./Popover";
import { PopoverList } from "./PopoverList";
import { Slot } from "./Slot";
import { AddButton } from "./AddButton";
import { OperatorChip } from "./OperatorChip";
import {
  renderActionContent,
  renderTriggerContent,
} from "./SentenceRenderer";

const TRIGGER_OPERATOR_OPTIONS = ["and", "or"] as const;
const ACTION_OPERATOR_OPTIONS = ["then", "and"] as const;
const DEFAULT_TRIGGER_OP: TriggerOperator = "and";
const DEFAULT_ACTION_OP: ActionOperator = "then";

/** Hard cap on chain length per side. The on-chain Automation account
 *  doesn't (yet) carry chains anyway, so this is a UX cap to keep the
 *  sentence readable and to bound the keeper's evaluation cost when
 *  multi-trigger rules eventually land. */
const MAX_CHAIN_LENGTH = 5;
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
import { ControlFlowChip } from "./ControlFlowChip";

type Side = "if" | "then";
type Stage = "list" | "edit";

export type BuilderResult = {
  triggers: Trigger[];
  triggerOperators: TriggerOperator[];
  actions: Action[];
  actionOperators: ActionOperator[];
  cadence: Cadence;
  minIntervalSecs: number;
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
  const [cadence, setCadence] = useState<Cadence>(
    () => initialState?.cadence ?? DEFAULT_CADENCE,
  );
  const [minIntervalSecs, setMinIntervalSecs] = useState<number>(
    () => initialState?.minIntervalSecs ?? DEFAULT_MIN_INTERVAL_SECS,
  );
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
    () => actionsForCadenceAndTriggers(cadence.kind, completedTriggerKinds),
    [cadence.kind, completedTriggerKinds],
  );
  const triggerCategoriesForMenu = useMemo(
    () => triggerCategoriesForCadence(cadence.kind),
    [cadence.kind],
  );
  const anyTriggerKindPicked = triggers.some((t) => t.kind != null);

  // When the user switches cadence (e.g. If → While), any trigger or action
  // that's no longer allowed under the new cadence resets to empty. Better
  // to surface "pick again" than to silently keep an invalid combo around.
  // We also seed `min_interval_secs` from the cadence default — without
  // this, While-with-a-token-price-trigger would fire on every keeper tick
  // because the on-chain floor stays at 0. The user can override the
  // floor in the TuningSheet before signing.
  const handleCadenceChange = (next: typeof cadence) => {
    setCadence(next);
    if (next.kind === "once") {
      setMinIntervalSecs(0);
    } else if (cadence.kind === "once") {
      setMinIntervalSecs(DEFAULT_INTERVAL_BY_CADENCE[next.kind]);
    }
    setTriggers((prev) =>
      prev.map((t) =>
        t.kind != null && !isTriggerKindAllowedForCadence(t.kind, next.kind)
          ? { ...EMPTY_TRIGGER }
          : t,
      ),
    );
    setActions((prev) =>
      prev.map((a) =>
        a.kind != null && !isActionKindAllowedForCadence(a.kind, next.kind)
          ? { ...EMPTY_ACTION }
          : a,
      ),
    );
  };

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
    if (!isTriggerSupported(kind)) return;
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
    if (!isTriggerCategorySupported(category)) return;
    const supportedKinds = category.kinds.filter((k) => isTriggerSupported(k.kind));
    // If only one supported kind exists in this category (regardless of how
    // many disabled siblings sit next to it), skip the sub-list and jump
    // straight to its editor.
    if (supportedKinds.length === 1) {
      pickTriggerKind(idx, supportedKinds[0].kind);
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
    if (!isActionSupported(kind)) return;
    const meta = findActionMeta(kind);
    if (!meta) return;
    setActions((prev) => prev.map((a, i) => (i === idx ? meta.empty() : a)));
    setStage("edit");
  };

  const addTrigger = () => {
    if (triggers.length >= MAX_CHAIN_LENGTH) return;
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
    if (actions.length >= MAX_CHAIN_LENGTH) return;
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
      cadence,
      minIntervalSecs,
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
          return (
            <RestakeEditor
              draft={a}
              onChange={(next) => updateActionAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
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
        // Sub-kind list inside a category — filter by cadence so the
        // user only sees triggers that read naturally under the current
        // If/While/For mode.
        const allowedKinds = browsingCategory.kinds.filter((k) =>
          isTriggerKindAllowedForCadence(k.kind, cadence.kind),
        );
        body = (
          <PopoverList
            title={browsingCategory.label}
            options={allowedKinds.map((k) => ({
              kind: k.kind,
              label: k.label,
              description: k.description,
              disabled: !isTriggerSupported(k.kind),
              disabledReason: COMING_SOON_LABEL,
            }))}
            selectedKind={cur?.kind ?? null}
            onPick={(o) => pickTriggerKind(open.index, o.kind as TriggerKind)}
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
            title={
              cadence.kind === "until"
                ? "While this is true"
                : cadence.kind === "repeat"
                ? "Each time this happens"
                : "When this happens"
            }
            options={triggerCategoriesForMenu.map((c) => ({
              kind: c.id,
              label: c.label,
              description: c.description,
              disabled: !isTriggerCategorySupported(c),
              disabledReason: COMING_SOON_LABEL,
            }))}
            selectedKind={currentCategoryId}
            onPick={(o) => {
              const cat = triggerCategoriesForMenu.find((c) => c.id === o.kind);
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
          options={availableActions.map((a) => ({
            kind: a.kind,
            label: a.label,
            description: a.description,
            disabled: !isActionSupported(a.kind),
            disabledReason: COMING_SOON_LABEL,
          }))}
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

  // ── Cluster computation for trigger OR-grouping ───────────────────
  // When the trigger chain contains at least one OR, the slots split into
  // AND-clusters: contiguous spans separated by ORs. Each AND-cluster gets
  // a translucent material wrapper so the OR's operands read as visually
  // distinct groups (AND binds tighter than OR, like × binds tighter than +).
  const computeTriggerClusters = () => {
    const clusters: { slotIndices: number[]; internalAndOpIndices: number[] }[] = [];
    const interClusterOrIndices: number[] = [];
    let cur: { slotIndices: number[]; internalAndOpIndices: number[] } = {
      slotIndices: [0],
      internalAndOpIndices: [],
    };
    for (let i = 0; i < triggerOps.length; i++) {
      if (triggerOps[i] === "or") {
        clusters.push(cur);
        interClusterOrIndices.push(i);
        cur = { slotIndices: [i + 1], internalAndOpIndices: [] };
      } else {
        cur.slotIndices.push(i + 1);
        cur.internalAndOpIndices.push(i);
      }
    }
    clusters.push(cur);
    return { clusters, interClusterOrIndices };
  };

  // Cluster wrapper for AND-grouped triggers inside an OR. Outline-only —
  // no background fill so the slot pills inside read in the *exact* same
  // color as a standalone slot outside the cluster. The hairline inset
  // border carries the entire visual grouping.
  const clusterBoxStyle = {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap" as const,
    rowGap: "0.625rem",
    columnGap: "0.5rem",
    padding: "0.3125rem 0.5rem",
    background: "transparent",
    borderRadius: "0.75rem",
    boxShadow: "inset 0 0 0 0.5px var(--separator)",
  };

  const renderChain = (
    side: Side,
    slots: Array<DraftTrigger | DraftAction>,
    lead: React.ReactNode,
    placeholder: string,
  ) => {
    const renderSlotAt = (i: number) => {
      const slot = slots[i];
      const isOpen = !!(open && open.side === side && open.index === i);
      const isReady = side === "if"
        ? triggerReady(slot as DraftTrigger)
        : actionReady(slot as DraftAction);
      const content = side === "if"
        ? renderTriggerContent(slot as DraftTrigger)
        : renderActionContent(slot as DraftAction);
      return (
        <Slot
          ref={refFor(side, i)}
          active={isOpen}
          hasValue={isReady}
          content={content}
          placeholder={placeholder}
          onClick={() => (isOpen ? closePopover() : openSlot(side, i))}
          onRemove={slots.length > 1 ? () => removeSlot(side, i) : undefined}
        />
      );
    };

    const renderOpChipAt = (opIndex: number) =>
      side === "if" ? (
        <OperatorChip
          value={(triggerOps[opIndex] ?? DEFAULT_TRIGGER_OP) as TriggerOperator}
          options={TRIGGER_OPERATOR_OPTIONS}
          onChange={(next) => setTriggerOp(opIndex, next)}
        />
      ) : (
        <OperatorChip
          value={(actionOps[opIndex] ?? DEFAULT_ACTION_OP) as ActionOperator}
          options={ACTION_OPERATOR_OPTIONS}
          onChange={(next) => setActionOp(opIndex, next)}
        />
      );

    const shouldClusterTriggers = side === "if" && triggerOps.includes("or");

    // Build the chain as { first, rest } so the lead word ("If" / "then") can
    // be visually bound to the first chunk via a single sub-flex-item — that
    // way when the chain wraps, the lead word travels with its content
    // instead of stranding alone above the next line.
    const renderCluster = (
      cluster: { slotIndices: number[]; internalAndOpIndices: number[] },
      keyPrefix: string,
    ) => {
      if (cluster.slotIndices.length === 1) {
        return renderSlotAt(cluster.slotIndices[0]);
      }
      return (
        <span style={clusterBoxStyle}>
          {cluster.slotIndices.map((slotIdx, k) => (
            <Fragment key={`${keyPrefix}-${slotIdx}`}>
              {k > 0 && renderOpChipAt(cluster.internalAndOpIndices[k - 1])}
              {renderSlotAt(slotIdx)}
            </Fragment>
          ))}
        </span>
      );
    };

    let first: React.ReactNode = null;
    let rest: React.ReactNode[] = [];
    if (shouldClusterTriggers) {
      const { clusters, interClusterOrIndices } = computeTriggerClusters();
      first = renderCluster(clusters[0], `${side}-c0`);
      rest = clusters.slice(1).map((c, idx) => {
        const ci = idx + 1;
        return (
          <Fragment key={`${side}-c-${ci}`}>
            {renderOpChipAt(interClusterOrIndices[ci - 1])}
            {renderCluster(c, `${side}-c${ci}`)}
          </Fragment>
        );
      });
    } else {
      first = slots.length > 0 ? renderSlotAt(0) : null;
      rest = slots.slice(1).map((_, idx) => {
        const i = idx + 1;
        return (
          <Fragment key={`${side}-s-${i}`}>
            {renderOpChipAt(i - 1)}
            {renderSlotAt(i)}
          </Fragment>
        );
      });
    }

    // Cadence detail (interval, deadline, count) lives in the TuningSheet
    // step between save and on-chain confirmation — not inline. Keeping
    // the sentence to just trigger/action makes both If and While read
    // cleanly: "If price drops below $103, then swap" / "While price is
    // below $103, then swap" without an interruption mid-clause.
    return (
      <span
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          rowGap: "0.625rem",
          columnGap: "0.5rem",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            columnGap: "0.5rem",
          }}
        >
          {lead}
          {first}
        </span>

        {rest}

        <AddButton
          onClick={() => (side === "if" ? addTrigger() : addAction())}
          disabled={slots.length >= MAX_CHAIN_LENGTH}
          aria-label={
            slots.length >= MAX_CHAIN_LENGTH
              ? `Maximum of ${MAX_CHAIN_LENGTH} ${side === "if" ? "triggers" : "actions"} reached`
              : `Add another ${side === "if" ? "trigger" : "action"}`
          }
          title={
            slots.length >= MAX_CHAIN_LENGTH
              ? `Maximum of ${MAX_CHAIN_LENGTH} ${side === "if" ? "triggers" : "actions"} reached`
              : undefined
          }
        />
      </span>
    );
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "48rem",
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
          gap: "1.75rem",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.875rem",
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
          {renderChain(
            "if",
            triggers,
            <ControlFlowChip cadence={cadence} onChange={handleCadenceChange} />,
            "choose a trigger",
          )}
          <div
            aria-hidden
            style={{
              height: "0.5px",
              background: "var(--separator)",
              opacity: 0.6,
            }}
          />
          {renderChain(
            "then",
            actions,
            <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>
              then
            </span>,
            "choose an action",
          )}
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
