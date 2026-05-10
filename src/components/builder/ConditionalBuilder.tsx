"use client";

import { createRef, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  Action,
  ActionOperator,
  Automation,
  ActionKind,
  BuilderResult,
  Cadence,
  ChainLinkClass,
  DraftAction,
  DraftTrigger,
  Trigger,
  TriggerKind,
  TriggerOperator,
} from "@/lib/types";
import {
  DEFAULT_CADENCE,
  DEFAULT_MIN_INTERVAL_SECS,
  EMPTY_ACTION,
  EMPTY_TRIGGER,
} from "@/lib/types";
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
import { AssetPriceEditor } from "./triggers/AssetPriceEditor";
import { AccountTransferEditor } from "./triggers/AccountTransferEditor";
import { AccountSwapEditor } from "./triggers/AccountSwapEditor";
import { TimeElapsedEditor } from "./triggers/TimeElapsedEditor";
import { PriceRelativeToFillEditor } from "./triggers/PriceRelativeToFillEditor";
import { TransferEditor } from "./actions/TransferEditor";
import { SwapEditor } from "./actions/SwapEditor";

type Side = "if" | "then";
type Stage = "list" | "edit";

// BuilderResult is defined in lib/types and re-exported here for components
// that import it from this path (backward-compat surface).
export type { BuilderResult };

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
    case "asset_price":
      return (
        t.asset != null && t.threshold != null && t.threshold > 0 && t.oracle != null
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
    case "time_elapsed":
      return t.value != null && t.value > 0;
    case "price_relative_to_fill":
      return t.upstream != null && t.pctBps != null && t.pctBps > 0;
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
        (a.consumeUpstreamOutput === true ||
          (a.amount != null && a.amount > 0))
      );
  }
}

export function ConditionalBuilder({
  initialState,
  onSave,
  cardLabel,
  bottomAccessory,
  onResultChange,
  hideSaveButton,
  onClose,
  linkClassUpstream,
  chainCtx,
}: {
  initialState?: Automation | null;
  onSave: (data: BuilderResult) => void;
  /** When set, renders a small numbered pill ("Rule 1", "Rule 2", …)
   *  in the top-right of the card so chain users can tell rules apart
   *  at a glance. Standalone-rule callers leave this undefined. */
  cardLabel?: string;
  /** Rendered inside the card below the rule sentence, attached to the
   *  bottom border. The LinkedChainBuilder uses this to attach a "+"
   *  slot for adding/looping linked rules without forking the
   *  ConditionalBuilder layout. */
  bottomAccessory?: React.ReactNode;
  /** Fires whenever the rule becomes ready (`result` set) or stops
   *  being ready (`null`). Lets a parent chain orchestrator track
   *  whether all cards are valid before enabling the chain Save
   *  button. Standalone callers don't need this — they react to
   *  `onSave`. */
  onResultChange?: (result: BuilderResult | null) => void;
  /** Suppresses the inner ✓ Save button. The chain orchestrator
   *  renders its own Save & Run button at the page level so the user
   *  saves the whole chain in one click. */
  hideSaveButton?: boolean;
  /** When present, renders a small × button in the top-right that
   *  invokes this callback (used by the chain to remove a card). */
  onClose?: () => void;
  /** The link class of the upstream chain link (i.e. the link connecting
   *  the previous card to this card). Used by action editors to surface
   *  upstream-aware options — e.g. the "Use upstream output" chip in
   *  SwapEditor when the upstream link is an inverted pair. */
  linkClassUpstream?: ChainLinkClass;
  /** Chain context forwarded to trigger editors so they can reveal
   *  upstream-aware options (e.g. PriceRelativeToFill). Only set when
   *  this card is a downstream node in a multi-rule chain AND its action
   *  consumes upstream output. When absent the trigger editors fall back
   *  to standalone (absolute-price only) mode. */
  chainCtx?: { upstreamIndex: number; consumeUpstream: boolean };
}) {
  const [triggers, setTriggers] = useState<DraftTrigger[]>(() => seedTriggers(initialState));
  const [actions, setActions] = useState<DraftAction[]>(() => seedActions(initialState));
  const [triggerOps, setTriggerOps] = useState<TriggerOperator[]>(() => seedTriggerOps(initialState));
  const [actionOps, setActionOps] = useState<ActionOperator[]>(() => seedActionOps(initialState));
  // The standalone builder always emits the default cadence (once) with no
  // interval floor — multi-fire behavior is expressed via linked-chain
  // self-links and back-link loops, not a per-rule cadence chip. The
  // initialState's cadence is preserved verbatim so editing an existing
  // rule with a non-once cadence (e.g. a chain rule pulled in for edit)
  // round-trips losslessly.
  const cadence: Cadence = initialState?.cadence ?? DEFAULT_CADENCE;
  const minIntervalSecs: number =
    initialState?.minIntervalSecs ?? DEFAULT_MIN_INTERVAL_SECS;
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
    const chainQualified =
      chainCtx != null &&
      chainCtx.upstreamIndex >= 0 &&
      chainCtx.consumeUpstream;
    const supportedKinds = category.kinds.filter(
      (k) =>
        isTriggerSupported(k.kind) &&
        (k.kind !== "price_relative_to_fill" || chainQualified),
    );
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
    // Only show the category sub-list on back-nav when MORE THAN ONE kind in
    // the category is actually selectable for this rule. Apply the same
    // chain-qualification filter that `pickTriggerCategory` uses so the back
    // path matches the forward path — otherwise users land on a redundant
    // one-row "sub-list" with only Asset Price in it.
    const chainQualified =
      chainCtx != null &&
      chainCtx.upstreamIndex >= 0 &&
      chainCtx.consumeUpstream;
    const supportedCount = cat
      ? cat.kinds.filter(
          (k) =>
            isTriggerSupported(k.kind) &&
            (k.kind !== "price_relative_to_fill" || chainQualified),
        ).length
      : 0;
    if (cat && supportedCount > 1) {
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

  // Notify parent (chain orchestrator) whenever the rule's readiness
  // changes. Done here rather than at every state mutation so we
  // capture all paths (slot pick, popover close, cadence change).
  //
  // The parent typically passes an INLINE arrow for `onResultChange`,
  // which means its identity changes every render. Including it in
  // the dep list would cause the effect to re-fire on every parent
  // render and feed-back through setCardResult → cards reference
  // change → parent re-render → loop. Stash the latest callback in a
  // ref and call it imperatively instead, so the effect only re-runs
  // when the COMPUTED rule shape actually changes.
  const onResultChangeRef = useRef(onResultChange);
  onResultChangeRef.current = onResultChange;
  useEffect(() => {
    const cb = onResultChangeRef.current;
    if (!cb) return;
    const t = freezeTriggers(triggers);
    const a = freezeActions(actions);
    if (!t || !a || !ready) {
      cb(null);
      return;
    }
    cb({
      triggers: t,
      triggerOperators: triggerOps,
      actions: a,
      actionOperators: actionOps,
      cadence,
      minIntervalSecs,
    });
  }, [triggers, actions, triggerOps, actionOps, cadence, minIntervalSecs, ready]);

  const renderEditor = () => {
    if (!open) return null;
    if (open.side === "if") {
      const t = triggers[open.index];
      const onBack = () => goBackFromEditor("if", open.index);
      const onConfirm = () => closePopover();
      switch (t.kind) {
        case "asset_price":
          return (
            <AssetPriceEditor
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
        case "time_elapsed":
          return (
            <TimeElapsedEditor
              draft={t}
              onChange={(next) => updateTriggerAt(open.index, next)}
              onBack={onBack}
              onConfirm={onConfirm}
            />
          );
        case "price_relative_to_fill":
          return (
            <PriceRelativeToFillEditor
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
              linkClassUpstream={linkClassUpstream}
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
        // Sub-kind list inside a category. The builder always runs in
        // the once-cadence shape, so every kind in the category is
        // allowed; the only filter is whether the kind is supported
        // by the current build of the program.
        // The PriceRelativeToFill sub-kind is only valid for downstream
        // consume-upstream-output rules. Hide it entirely (not just disabled)
        // unless the chain context says this card qualifies.
        const chainQualified =
          chainCtx != null &&
          chainCtx.upstreamIndex >= 0 &&
          chainCtx.consumeUpstream;
        const filteredKinds = browsingCategory.kinds.filter(
          (k) => k.kind !== "price_relative_to_fill" || chainQualified,
        );
        body = (
          <PopoverList
            title={browsingCategory.label}
            options={filteredKinds.map((k) => ({
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
            title="When this happens"
            options={TRIGGER_CATEGORIES.map((c) => ({
              kind: c.id,
              label: c.label,
              description: c.description,
              disabled: !isTriggerCategorySupported(c),
              disabledReason: COMING_SOON_LABEL,
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

    // The standalone builder reads as a flat "If <triggers>, then
    // <actions>" sentence. Loop semantics (count, deadline, interval)
    // are owned by the LinkedChainBuilder's loop affordances, not by
    // an inline cadence chip — keeping the sentence single-shot makes
    // it read cleanly without an interruption mid-clause.
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
        padding: "2rem 2.25rem 0",
        position: "relative",
      }}
    >
      {(cardLabel || onClose) && (
        <div
          style={{
            position: "absolute",
            top: "0.75rem",
            right: "0.75rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            zIndex: 1,
          }}
        >
          {cardLabel && (
            <span
              className="hig-caption-1"
              style={{
                padding: "0.1875rem 0.5rem",
                borderRadius: "999px",
                background: "var(--fill-4)",
                color: "var(--label-secondary)",
                fontWeight: 600,
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }}
            >
              {cardLabel}
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Remove rule"
              title="Remove this rule from the chain"
              style={{
                width: "1.5rem",
                height: "1.5rem",
                borderRadius: "999px",
                background: "var(--fill-3)",
                color: "var(--label-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: "0.875rem",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1.75rem",
          justifyContent: "space-between",
          paddingBottom: "2rem",
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
            <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>
              If
            </span>,
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
        {!hideSaveButton && (
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
        )}
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

      {bottomAccessory && (
        <div
          style={{
            marginTop: "0.5rem",
            borderTop: "0.5px solid var(--separator)",
            padding: "0.875rem 0",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {bottomAccessory}
        </div>
      )}
    </div>
  );
}
