"use client";

import { createRef, useRef, useState, type RefObject } from "react";
import type { ActionOption, Automation, Option, Slot, TriggerOption } from "@/lib/types";
import { ACTIONS, TRIGGERS } from "@/lib/catalog";
import { useSolPrice } from "@/hooks/useSolPrice";
import { formatSlotValue } from "@/lib/format";
import { Check } from "../icons";
import { Popover } from "./Popover";
import { PopoverList } from "./PopoverList";
import { ValueDetail } from "./ValueDetail";
import { SlotWithRemove } from "./SlotWithRemove";
import { AddButton } from "./AddButton";

type Side = "if" | "then";

export type BuilderResult = {
  triggers: Slot<TriggerOption>[];
  actions: Slot<ActionOption>[];
};

function emptySlot<O extends Option>(): Slot<O> {
  return { choice: null, value: null };
}

function seedFrom(initial: Automation | null | undefined): {
  triggers: Slot<TriggerOption>[];
  actions: Slot<ActionOption>[];
} {
  return {
    triggers: initial?.triggers?.length ? initial.triggers : [emptySlot<TriggerOption>()],
    actions: initial?.actions?.length ? initial.actions : [emptySlot<ActionOption>()],
  };
}

function slotReady(s: Slot): boolean {
  return Boolean(s && s.choice && (!s.choice.needsValue || s.value));
}

export function ConditionalBuilder({
  initialState,
  onSave,
}: {
  initialState?: Automation | null;
  onSave: (data: BuilderResult) => void;
}) {
  const [triggers, setTriggers] = useState<Slot<TriggerOption>[]>(() => seedFrom(initialState).triggers);
  const [actions, setActions] = useState<Slot<ActionOption>[]>(() => seedFrom(initialState).actions);
  const [open, setOpen] = useState<{ side: Side; index: number } | null>(null);
  const [stage, setStage] = useState<"list" | "detail">("list");
  const [stagedChoice, setStagedChoice] = useState<Option | null>(null);

  const needsLivePrice = !!open && stage === "detail" && stagedChoice?.valueType === "price";
  const { price: solPrice } = useSolPrice({ enabled: needsLivePrice });

  const refsRef = useRef<Record<string, RefObject<HTMLButtonElement>>>({});
  const refFor = (side: Side, idx: number): RefObject<HTMLButtonElement> => {
    const k = `${side}:${idx}`;
    if (!refsRef.current[k]) refsRef.current[k] = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;
    return refsRef.current[k];
  };

  const triggersReady = triggers.every(slotReady);
  const actionsReady = actions.every(slotReady);
  const ready = triggersReady && actionsReady;

  const closePopover = () => {
    setOpen(null);
    setStage("list");
    setStagedChoice(null);
  };

  const openSlot = (side: Side, idx: number) => {
    setOpen({ side, index: idx });
    const arr = side === "if" ? triggers : actions;
    const cur = arr[idx]?.choice;
    if (cur && cur.needsValue) {
      setStagedChoice(cur);
      setStage("detail");
    } else {
      setStage("list");
      setStagedChoice(null);
    }
  };

  const updateTriggerSlot = (idx: number, patch: Partial<Slot<TriggerOption>>) => {
    setTriggers((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const updateActionSlot = (idx: number, patch: Partial<Slot<ActionOption>>) => {
    setActions((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const addSlot = (side: Side) => {
    const newIndex = (side === "if" ? triggers : actions).length;
    if (side === "if") setTriggers((prev) => [...prev, emptySlot<TriggerOption>()]);
    else setActions((prev) => [...prev, emptySlot<ActionOption>()]);
    requestAnimationFrame(() => requestAnimationFrame(() => openSlot(side, newIndex)));
  };

  const removeSlot = (side: Side, idx: number) => {
    if (side === "if") {
      setTriggers((prev) => (prev.length === 1 ? [emptySlot<TriggerOption>()] : prev.filter((_, i) => i !== idx)));
    } else {
      setActions((prev) => (prev.length === 1 ? [emptySlot<ActionOption>()] : prev.filter((_, i) => i !== idx)));
    }
    if (open && open.side === side && open.index === idx) closePopover();
  };

  const pickOption = (opt: Option) => {
    if (!open) return;
    if (opt.needsValue) {
      setStagedChoice(opt);
      setStage("detail");
    } else {
      if (open.side === "if") updateTriggerSlot(open.index, { choice: opt as TriggerOption, value: null });
      else updateActionSlot(open.index, { choice: opt as ActionOption, value: null });
      closePopover();
    }
  };

  const commitValue = (v: number) => {
    if (!open || !stagedChoice) return;
    if (open.side === "if") updateTriggerSlot(open.index, { choice: stagedChoice as TriggerOption, value: v });
    else updateActionSlot(open.index, { choice: stagedChoice as ActionOption, value: v });
    closePopover();
  };

  const handleSave = () => {
    if (!ready) return;
    onSave({ triggers, actions });
  };

  const renderChain = (
    side: Side,
    slots: Slot[],
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
        return (
          <span
            key={`${side}-${i}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              whiteSpace: "nowrap",
            }}
          >
            {i > 0 && <span style={{ color: "var(--label-secondary)", fontWeight: 400 }}>and</span>}
            <SlotWithRemove
              slotRef={refFor(side, i)}
              active={isOpen}
              hasValue={slotReady(slot)}
              value={formatSlotValue(slot)}
              placeholder={placeholder}
              showRemove={slots.length > 1}
              onClick={() => (isOpen ? closePopover() : openSlot(side, i))}
              onRemove={() => removeSlot(side, i)}
            />
          </span>
        );
      })}
      <AddButton
        onClick={() => addSlot(side)}
        aria-label={`Add another ${side === "if" ? "trigger" : "action"}`}
      />
    </span>
  );

  const popoverContent = (() => {
    if (!open) return null;
    const arr = open.side === "if" ? triggers : actions;
    const cur = arr[open.index];
    const opts = open.side === "if" ? TRIGGERS : ACTIONS;
    const title = open.side === "if" ? "When this happens" : "Do this";
    return (
      <Popover anchorRef={refFor(open.side, open.index)} open={true} onClose={closePopover}>
        {stage === "list" || !stagedChoice ? (
          <PopoverList title={title} options={opts} selectedId={cur?.choice?.id} onPick={pickOption} />
        ) : (
          <ValueDetail
            option={stagedChoice}
            value={cur?.value}
            onConfirm={commitValue}
            onBack={() => setStage("list")}
            side={open.side}
            livePrice={solPrice}
          />
        )}
      </Popover>
    );
  })();

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
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", justifyContent: "space-between" }}>
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
            fontSize: "1.75rem",
            lineHeight: "2.125rem",
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

      {popoverContent}
    </div>
  );
}
