"use client";

/* ─────────────────────────────────────────────────────────────────────
   LinkedChainBuilder — orchestrates 1-3 ConditionalBuilder cards into a
   chain. Single-card mode degrades exactly to the prior single-rule UX;
   2-3 card mode adds chain badges, link slots on the bottom border, a
   loop-back affordance, and a top-level Save Chain button.

   Chain shapes supported:
     • Linear chain (head → ... → terminal): N rules, last rule's link
       is null, output goes back to user wallet.
     • Loop chain (head → ... → head): N rules, last rule's link points
       back to the head, forming a perpetual cycle. This is the arb
       use case — "USDC ratio < 0.99 → buy" / "USDC ratio > 1.01 → sell"
       loops indefinitely as price oscillates.

   Mint-flow validation runs continuously and the Save Chain button
   stays disabled until every adjacent pair lines up.
   ───────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Automation, BuilderResult, ChainLinkClass, LoopMode } from "@/lib/types";
import { DEFAULT_LOOP_CYCLES, MAX_CHAIN_LENGTH } from "@/lib/types";
import { ConditionalBuilder } from "./ConditionalBuilder";
import {
  type ChainNodeDraft,
  type ChainNodeNextDraft,
  classifyChainLink,
  findCycleNodes,
  validateChainDraft,
  type ChainValidationError,
} from "@/lib/linked-chains";
import { Check, Plus } from "../icons";

type CardState = {
  /** Stable id used as React key — survives reorders/removes. */
  id: string;
  /** Optional initial rule when the user is editing a saved chain.
   *  Undefined for fresh draft cards. */
  initial: Automation | null;
  /** Latest valid result the inner ConditionalBuilder reported, or
   *  null when the rule is incomplete. The chain is only saveable when
   *  every card has a non-null result. */
  result: BuilderResult | null;
  /** Where this card's swap output goes. `null` = terminal (chain
   *  stops here, output to user wallet). `{ kind: "rule", ruleIndex }`
   *  = forward link. `{ kind: "loopBack" }` = back to card 0. */
  link: ChainNodeNextDraft | null;
};

let cardIdCounter = 0;
function newCardId(): string {
  cardIdCounter += 1;
  return `card_${cardIdCounter}`;
}

export type ChainSaveData = {
  nodes: ChainNodeDraft[];
  /** Loop topology applied across the chain at submit time. `null`
   *  means linear (terminal at last rule). Set when the user picks a
   *  loop option in the LoopSlot. */
  loopMode: LoopMode | null;
};

export function LinkedChainBuilder({
  initialState,
  onSaveSingle,
  onSaveChain,
}: {
  /** Single-rule edit case. When provided, the chain seeds with one
   *  card initialised from this automation (no chain UI shown). The
   *  page-level handler still routes through `onSaveSingle` for the
   *  one-card path so the existing DepositSheet flow stays unchanged. */
  initialState?: Automation | null;
  /** Fires when the user saves a 1-card chain — same shape and
   *  semantics as the old standalone ConditionalBuilder save. */
  onSaveSingle: (data: BuilderResult) => void;
  /** Fires when the user saves a 2-3 card chain. The page-level
   *  handler is responsible for opening the ChainDepositSheet, which
   *  builds the atomic multi-create transaction. */
  onSaveChain: (data: ChainSaveData) => void;
}) {
  const [cards, setCards] = useState<CardState[]>(() => [
    { id: newCardId(), initial: initialState ?? null, result: null, link: null },
  ]);
  /** When non-null, the chain runs in "looped" mode. For 1-card, this
   *  makes the rule a self-loop (cadence-driven, no destination
   *  routing). For 2-3 card chains, the last card's `next` is set to
   *  loopBack and every rule's cadence is overridden by the loop
   *  template at submit time. */
  const [loopMode, setLoopMode] = useState<LoopMode | null>(null);

  // Chain mode kicks in whenever there are 2+ cards OR the user
  // selected a loop on a single card. Single-card non-looped saves
  // continue through the legacy single-rule path so the
  // single-rule DepositSheet flow stays undisturbed.
  const isChain = cards.length > 1 || loopMode != null;

  /* ── Card lifecycle ──────────────────────────────────────────── */

  const addNewCard = useCallback(() => {
    setCards((prev) => {
      if (prev.length >= MAX_CHAIN_LENGTH) return prev;
      const nextIdx = prev.length;
      const updated = prev.map((c, i) =>
        // The previous-last card now points forward to the freshly
        // appended card. Preserve any earlier mid-chain forward links.
        i === nextIdx - 1
          ? { ...c, link: { kind: "rule" as const, ruleIndex: nextIdx } }
          : c,
      );
      return [
        ...updated,
        { id: newCardId(), initial: null, result: null, link: null },
      ];
    });
  }, []);

  const removeCardAt = useCallback(
    (index: number) => {
      setCards((prev) => {
        if (prev.length === 1 || index === 0) return prev;
        const filtered = prev.filter((_, i) => i !== index);
        // Re-index links so they still point at valid slots.
        // Mid-chain forward links snap to (i + 1). The last card's
        // link is preserved if it pointed at a still-valid index;
        // otherwise it falls back to terminal.
        return filtered.map((c, i) => {
          if (!c.link) return c;
          const isLast = i === filtered.length - 1;
          if (!isLast) {
            // Mid-card always points to the next slot.
            return { ...c, link: { kind: "rule", ruleIndex: i + 1 } };
          }
          // Last card: keep link if target index is still in range
          // and isn't pointing at the just-removed slot.
          const target = c.link.ruleIndex;
          if (target >= filtered.length) return { ...c, link: null };
          return c;
        });
      });
      // If we just shrank back to 1 card and a loopMode was set
      // (the chain was looped), preserve it as a self-loop on the
      // remaining card. The submit path already handles 1-node loop
      // shape.
    },
    [],
  );

  const setCardLink = useCallback(
    (index: number, link: ChainNodeNextDraft | null) => {
      setCards((prev) => prev.map((c, i) => (i === index ? { ...c, link } : c)));
    },
    [],
  );

  const setCardResult = useCallback(
    (index: number, result: BuilderResult | null) => {
      setCards((prev) => {
        const cur = prev[index];
        if (!cur) return prev;
        if (cur.result === result) return prev;
        return prev.map((c, i) => (i === index ? { ...c, result } : c));
      });
    },
    [],
  );

  /** Set the loop mode without touching link topology. Used when the
   *  LoopModal applies a frequency/infinite choice for an already-
   *  picked back-link, or when the user clears looping. */
  const setLoopOnly = useCallback((mode: LoopMode | null) => {
    setLoopMode(mode);
  }, []);

  // Pending back-link target awaiting loop-mode confirmation. When
  // the user picks "Link back to Rule X" from the menu, we stash the
  // candidate link here and pop the LoopModal. Apply commits the
  // link + sets loopMode; Cancel discards the link.
  const [pendingBackLink, setPendingBackLink] = useState<{
    cardIndex: number;
    targetRuleIndex: number;
    /** The link state before the user picked the back-link, so Cancel
     *  can revert to whatever was previously set (terminal, forward,
     *  or a different back-link). */
    prevLink: ChainNodeNextDraft | null;
    prevLoopMode: LoopMode | null;
  } | null>(null);

  // Pending forward-link kill awaiting confirmation. When the user
  // clicks the × on a mid-chain card whose downstream rules have
  // partial work, we pop a warning modal that lists what will be
  // deleted. Confirm cuts the chain at this card.
  const [pendingKillCascade, setPendingKillCascade] = useState<{
    cardIndex: number;
    downstreamCount: number;
    filledCount: number;
  } | null>(null);

  /** Stage a back-link pick from the LinkSlot. The link is applied to
   *  the card immediately so the user sees the arrow update; the
   *  LoopModal then asks for the run mode. Cancel reverts; Apply
   *  commits the loop mode. */
  const stageBackLink = useCallback(
    (cardIndex: number, targetRuleIndex: number) => {
      const cur = cards[cardIndex];
      if (!cur) return;
      setPendingBackLink({
        cardIndex,
        targetRuleIndex,
        prevLink: cur.link,
        prevLoopMode: loopMode,
      });
      setCards((prev) =>
        prev.map((c, i) =>
          i === cardIndex
            ? { ...c, link: { kind: "rule", ruleIndex: targetRuleIndex } }
            : c,
        ),
      );
      // Self-link doesn't go through any chain destination routing —
      // the arrow + loop-mode are the only signals. Pre-set a default
      // loopMode so backLinkTarget resolves immediately and the arrow
      // renders behind the modal. The Apply / Cancel buttons in the
      // modal still commit or revert; this is just a UX preview so
      // the user sees the link visually take effect.
      setLoopMode((cur) => cur ?? { kind: "frequency", cycles: DEFAULT_LOOP_CYCLES });
    },
    [cards, loopMode],
  );

  const cancelBackLink = useCallback(() => {
    setPendingBackLink((cur) => {
      if (!cur) return null;
      setCards((prev) =>
        prev.map((c, i) => (i === cur.cardIndex ? { ...c, link: cur.prevLink } : c)),
      );
      setLoopMode(cur.prevLoopMode);
      return null;
    });
  }, []);

  const applyBackLinkLoop = useCallback((mode: LoopMode) => {
    setPendingBackLink(null);
    setLoopMode(mode);
  }, []);

  /** Kill the link on a card. Three cases:
   *   - Back-link or self-link: just clear the link + loop mode.
   *   - Mid-chain forward link with EMPTY downstream rules: silently
   *     trim the chain at this card (no need to bother the user with
   *     a confirmation if there's nothing to delete).
   *   - Mid-chain forward link with downstream rules that have at
   *     least one filled trigger/action: pop the warning modal so
   *     the user confirms the cascade delete. */
  const killLink = useCallback(
    (cardIndex: number) => {
      const card = cards[cardIndex];
      if (!card?.link) return;
      const isBackLink = card.link.ruleIndex <= cardIndex;
      if (isBackLink) {
        setCards((prev) =>
          prev.map((c, i) => (i === cardIndex ? { ...c, link: null } : c)),
        );
        setLoopMode(null);
        return;
      }
      const downstream = cards.slice(cardIndex + 1);
      const filled = downstream.filter((c) => c.result != null).length;
      if (filled === 0) {
        // Nothing the user might lose — just trim.
        setCards((prev) =>
          prev.slice(0, cardIndex + 1).map((c, i) =>
            i === cardIndex ? { ...c, link: null } : c,
          ),
        );
        return;
      }
      setPendingKillCascade({
        cardIndex,
        downstreamCount: downstream.length,
        filledCount: filled,
      });
    },
    [cards],
  );

  const confirmKillCascade = useCallback(() => {
    if (!pendingKillCascade) return;
    const idx = pendingKillCascade.cardIndex;
    setCards((prev) =>
      prev.slice(0, idx + 1).map((c, i) =>
        i === idx ? { ...c, link: null } : c,
      ),
    );
    // If we just shrank back to 1 card, also drop loop mode (the
    // remaining card no longer has a chain to belong to).
    setLoopMode((cur) => (idx === 0 ? null : cur));
    setPendingKillCascade(null);
  }, [pendingKillCascade]);

  const cancelKillCascade = useCallback(() => {
    setPendingKillCascade(null);
  }, []);

  /* ── Derived state — chain validity ──────────────────────────── */

  const allReady = cards.every((c) => c.result != null);

  const draftNodes = useMemo<ChainNodeDraft[] | null>(() => {
    if (!allReady) return null;
    return cards.map((c) => ({
      result: c.result!,
      next: c.link,
    }));
  }, [cards, allReady]);

  const chainError = useMemo<ChainValidationError | null>(() => {
    if (!isChain || !draftNodes) return null;
    return validateChainDraft(draftNodes);
  }, [draftNodes, isChain]);

  const chainReady = isChain && allReady && chainError == null;

  const linkClasses: ChainLinkClass[] = useMemo(() => {
    const out: ChainLinkClass[] = [];
    for (let i = 0; i < cards.length - 1; i++) {
      const up = cards[i].result;
      const down = cards[i + 1].result;
      if (!up || !down) {
        // Unknown until both cards are ready — neutral default. The
        // badge will re-render once the user finishes both cards.
        out.push("matched_mints");
        continue;
      }
      out.push(classifyChainLink(up, down));
    }
    return out;
  }, [cards]);

  /* ── Refs for SVG arrow positioning ─────────────────────────── */

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Reset refs array when card count changes to avoid stale entries.
  cardRefs.current = cardRefs.current.slice(0, cards.length);

  const [arrowGeom, setArrowGeom] = useState<{
    path: string;
    width: number;
    height: number;
  } | null>(null);

  // Resolve the back-link target index. For a multi-card chain, the
  // last card's link reveals where the loop goes back to (head, mid,
  // etc.). For 1-card self-loop, the source and target are the same
  // card. When no loopMode is set, no arrow is drawn.
  const backLinkTarget = useMemo<{ sourceIdx: number; targetIdx: number } | null>(() => {
    if (!loopMode) return null;
    if (cards.length === 1) return { sourceIdx: 0, targetIdx: 0 };
    const lastIdx = cards.length - 1;
    const lastLink = cards[lastIdx]?.link;
    if (!lastLink || lastLink.ruleIndex > lastIdx) return null;
    return { sourceIdx: lastIdx, targetIdx: lastLink.ruleIndex };
  }, [cards, loopMode]);

  useLayoutEffect(() => {
    if (!loopMode || !backLinkTarget) {
      // Bail without setState if geometry is already null — avoids
      // gratuitous re-renders during the common "no loop yet" path.
      setArrowGeom((prev) => (prev == null ? prev : null));
      return;
    }
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const sourceCard = cardRefs.current[backLinkTarget.sourceIdx];
      const targetCard = cardRefs.current[backLinkTarget.targetIdx];
      if (!sourceCard || !targetCard) return;
      const sourceRect = sourceCard.getBoundingClientRect();
      const targetRect = targetCard.getBoundingClientRect();
      const width = containerRect.width;
      const height = containerRect.height;
      // Anchor points: mid-right of each card, in container-local
      // coordinates. The arrow leaves the source's mid-right and
      // arrives at the target's mid-right with the arrowhead's tip
      // touching that midpoint.
      const sourceMidRightX = sourceRect.right - containerRect.left;
      const sourceMidRightY =
        sourceRect.top + sourceRect.height / 2 - containerRect.top;
      const targetMidRightX = targetRect.right - containerRect.left;
      const targetMidRightY =
        targetRect.top + targetRect.height / 2 - containerRect.top;
      let path: string;
      if (backLinkTarget.sourceIdx === backLinkTarget.targetIdx) {
        // Self-link: open C-curve on the right side. The arrow leaves
        // from above the card's mid-right and arrives at a separate
        // point below, so start and end are visually distinct rather
        // than collapsed onto a single coordinate.
        const verticalSpread = 28;
        const horizontalOffset = 56;
        const startY = sourceMidRightY - verticalSpread;
        const endY = sourceMidRightY + verticalSpread;
        path = `M ${sourceMidRightX} ${startY} C ${sourceMidRightX + horizontalOffset} ${startY}, ${sourceMidRightX + horizontalOffset} ${endY}, ${sourceMidRightX} ${endY}`;
      } else {
        // Multi-card back-link: arc from source mid-right to target
        // mid-right. Control points sit horizontally to the right of
        // each endpoint so the tangent at both ends is horizontal —
        // the line leaves the source pointing right and arrives at
        // the target pointing left.
        const offset = Math.max(
          72,
          Math.abs(sourceMidRightY - targetMidRightY) * 0.55,
        );
        path = `M ${sourceMidRightX} ${sourceMidRightY} C ${sourceMidRightX + offset} ${sourceMidRightY}, ${targetMidRightX + offset} ${targetMidRightY}, ${targetMidRightX} ${targetMidRightY}`;
      }
      setArrowGeom((prev) =>
        prev &&
        prev.path === path &&
        prev.width === width &&
        prev.height === height
          ? prev
          : { path, width, height },
      );
    };
    // Run after layout. Re-measure on window resize so the arrow
    // tracks card geometry.
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    cardRefs.current.forEach((c) => c && ro.observe(c));
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [loopMode, backLinkTarget, cards]);

  /* ── Save handlers ───────────────────────────────────────────── */

  const handleSaveSingle = useCallback(
    (data: BuilderResult) => {
      // Single-card path — preserve existing single-rule flow.
      onSaveSingle(data);
    },
    [onSaveSingle],
  );

  const handleSaveChain = useCallback(() => {
    if (!chainReady || !draftNodes) return;
    onSaveChain({ nodes: draftNodes, loopMode });
  }, [chainReady, draftNodes, onSaveChain, loopMode]);

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        maxWidth: "48rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        position: "relative",
      }}
    >
      {arrowGeom && (
        <LoopBackSvg
          path={arrowGeom.path}
          width={arrowGeom.width}
          height={arrowGeom.height}
          label={
            loopMode?.kind === "infinite"
              ? "loops · until depleted"
              : `loops · ${loopMode?.kind === "frequency" ? loopMode.cycles : DEFAULT_LOOP_CYCLES} cycles`
          }
        />
      )}
      {cards.map((card, i) => {
        const cardLabel = isChain
          ? cards.length === 1
            ? "Self-link"
            : `Rule ${i + 1} of ${cards.length}`
          : undefined;
        const isLast = i === cards.length - 1;
        const hideSave = isChain;
        const onClose = isChain && i > 0 ? () => removeCardAt(i) : undefined;

        return (
          <div
            key={card.id}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            style={{ position: "relative" }}
          >
            <ConditionalBuilder
              initialState={card.initial}
              onSave={handleSaveSingle}
              cardLabel={cardLabel}
              linkClassUpstream={i > 0 ? linkClasses[i - 1] : undefined}
              bottomAccessory={
                <LinkSlot
                  index={i}
                  totalCards={cards.length}
                  link={card.link}
                  loopMode={loopMode}
                  onAddCard={() => addNewCard()}
                  onPickBackLink={(targetRuleIndex) =>
                    stageBackLink(i, targetRuleIndex)
                  }
                  onClearBackLink={() => {
                    setCardLink(i, null);
                    setLoopOnly(null);
                  }}
                  onKillLink={() => killLink(i)}
                  isLast={isLast}
                />
              }
              onResultChange={(r) => setCardResult(i, r)}
              hideSaveButton={hideSave}
              onClose={onClose}
            />
            {isChain && i < cards.length - 1 && (
              <ChainArrow hint="Rule output flows into next rule's input" />
            )}
          </div>
        );
      })}

      {isChain && (
        <ChainSaveBar
          ready={chainReady}
          error={chainError}
          cards={cards.length}
          loopMode={loopMode}
          hasBridgedLink={linkClasses.some((c) => c === "bridge_required")}
          onSave={handleSaveChain}
        />
      )}

      {pendingBackLink && (
        <LoopModeModal
          sourceRule={pendingBackLink.cardIndex + 1}
          targetRule={pendingBackLink.targetRuleIndex + 1}
          initialMode={loopMode}
          onCancel={cancelBackLink}
          onApply={applyBackLinkLoop}
        />
      )}
      {pendingKillCascade && (
        <KillCascadeModal
          cardLabel={pendingKillCascade.cardIndex + 1}
          downstreamCount={pendingKillCascade.downstreamCount}
          filledCount={pendingKillCascade.filledCount}
          onCancel={cancelKillCascade}
          onConfirm={confirmKillCascade}
        />
      )}
    </div>
  );
}

/* ── LinkSlot — bottom-of-card "+" button + menu ────────────────── */

function LinkSlot({
  index,
  totalCards,
  link,
  loopMode,
  onAddCard,
  onPickBackLink,
  onClearBackLink,
  onKillLink,
  isLast,
}: {
  index: number;
  totalCards: number;
  link: ChainNodeNextDraft | null;
  loopMode: LoopMode | null;
  onAddCard: () => void;
  /** Stage a back-link to the rule at zero-based `targetRuleIndex`.
   *  Triggers the LoopModeModal in the parent to confirm the run mode
   *  before the link sticks. */
  onPickBackLink: (targetRuleIndex: number) => void;
  onClearBackLink: () => void;
  /** Kill the current link with cascade-aware behaviour: forward
   *  links to filled-out downstream rules trigger a confirm modal in
   *  the parent before deletion. */
  onKillLink: () => void;
  isLast: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovering, setHovering] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // Mid-chain cards (not last) carry a fixed forward link — surface
  // it as a read-only chip plus a hover-revealed × that breaks the
  // chain at this card.
  if (!isLast) {
    return (
      <div
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
        }}
      >
        <span
          className="hig-footnote"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.375rem",
            padding: "0.25rem 0.625rem",
            borderRadius: "999px",
            background: "var(--accent-fill)",
            color: "var(--accent)",
            fontWeight: 500,
          }}
        >
          Linked to Rule {index + 2}
        </span>
        <KillLinkButton
          visible={hovering}
          title={`Cut chain after Rule ${index + 1}`}
          onClick={onKillLink}
        />
      </div>
    );
  }

  const canAddMore = totalCards < MAX_CHAIN_LENGTH;
  const isBackLink = link != null && link.ruleIndex <= index;
  const isLoopMode = loopMode != null;

  // Compose the slot's summary line.
  let summary: string;
  let glyph: React.ReactNode = <Plus size={11} />;
  if (isBackLink) {
    glyph = "↩";
    const target = link!.ruleIndex + 1;
    const isSelf = link!.ruleIndex === index;
    if (isLoopMode && loopMode!.kind === "frequency") {
      summary = isSelf
        ? `Self-link · ${loopMode!.cycles} cycles`
        : `Linked back to Rule ${target} · ${loopMode!.cycles} cycles`;
    } else if (isLoopMode && loopMode!.kind === "infinite") {
      summary = isSelf
        ? `Self-link · infinite`
        : `Linked back to Rule ${target} · infinite`;
    } else {
      summary = isSelf ? "Self-link" : `Linked back to Rule ${target}`;
    }
  } else if (totalCards === 1) {
    summary = "Add another rule or self-link";
  } else if (link === null) {
    summary = "Terminal — output to wallet";
  } else {
    summary = `Linked to Rule ${link.ruleIndex + 1}`;
  }

  const closeMenu = () => setMenuOpen(false);

  // Build the list of valid back-link targets for this last card.
  // Any rule from the chain head up to and including this card itself
  // is a legal target — the bridge dispatcher handles mismatched-mint
  // self-loops by refilling the input ATA between fires.
  const backLinkTargets: number[] = [];
  for (let t = 0; t <= index; t++) backLinkTargets.push(t);

  const showKill = link != null;
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.375rem",
      }}
    >
      <button
        ref={btnRef}
        onClick={() => setMenuOpen((o) => !o)}
        className="hig-footnote"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.3125rem 0.75rem",
          borderRadius: "999px",
          background: isBackLink ? "var(--accent-fill)" : "var(--fill-4)",
          color: isBackLink ? "var(--accent)" : "var(--label-secondary)",
          border: "0.5px solid var(--separator)",
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <span>{glyph}</span>
        <span>{summary}</span>
      </button>
      {showKill && (
        <KillLinkButton
          visible={hovering}
          title="Remove link"
          onClick={onKillLink}
        />
      )}
      {menuOpen && (
        <>
          <div
            onClick={closeMenu}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 20,
              background: "transparent",
            }}
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              top: "calc(100% + 0.375rem)",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 21,
              minWidth: "18rem",
              background: "var(--bg-system)",
              border: "0.5px solid var(--separator)",
              borderRadius: "0.625rem",
              boxShadow: "var(--shadow-popover)",
              padding: "0.375rem",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {canAddMore && (
              <MenuItem
                title={`Add Rule ${totalCards + 1}`}
                description="Spawn another rule. Output of this rule funds the new one."
                onClick={() => {
                  onAddCard();
                  closeMenu();
                }}
              />
            )}
            {backLinkTargets.map((t) => {
              const isSelf = t === index;
              const targetLabel = isSelf ? "itself" : `Rule ${t + 1}`;
              const isActive = isBackLink && link!.ruleIndex === t;
              return (
                <MenuItem
                  key={`back-${t}`}
                  title={isSelf ? "Self-link" : `Link back to Rule ${t + 1}`}
                  description={
                    isSelf
                      ? "Fires repeatedly using the deposit until the funds run out."
                      : `Output funds Rule ${t + 1} again. Loops ${t + 1} → … → ${index + 1} → ${t + 1}.`
                  }
                  active={isActive}
                  onClick={() => {
                    onPickBackLink(t);
                    closeMenu();
                  }}
                  trailing={
                    isActive && loopMode
                      ? loopMode.kind === "infinite"
                        ? "↻ infinite"
                        : `↻ ${loopMode.cycles}×`
                      : undefined
                  }
                  ariaLabel={
                    isSelf ? "Self-link" : `Link back to ${targetLabel}`
                  }
                />
              );
            })}
            {(isBackLink || (totalCards > 1 && link != null)) && (
              <MenuItem
                title={
                  isBackLink
                    ? "Remove link"
                    : totalCards === 1
                      ? "Remove self-link"
                      : "End chain here"
                }
                description="Single rules save with their cadence. Chains end at this rule and the output goes to your wallet."
                onClick={() => {
                  onClearBackLink();
                  closeMenu();
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function KillLinkButton({
  visible,
  title,
  onClick,
}: {
  visible: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: "1.375rem",
        height: "1.375rem",
        borderRadius: "999px",
        background: "var(--fill-3)",
        color: "var(--label-secondary)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 120ms",
        cursor: "pointer",
        fontSize: "0.875rem",
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      ×
    </button>
  );
}

function MenuItem({
  title,
  description,
  onClick,
  active,
  trailing,
  ariaLabel,
}: {
  title: string;
  description: string;
  onClick: () => void;
  active?: boolean;
  /** Optional right-aligned chip — used to surface the active loop
   *  mode next to the matching back-link entry. */
  trailing?: string;
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.5rem 0.625rem",
        borderRadius: "0.4375rem",
        background: active
          ? "color-mix(in oklab, var(--accent) 12%, transparent)"
          : hover
            ? "var(--fill-4)"
            : "transparent",
        cursor: "pointer",
      }}
    >
      <div
        className="hig-subheadline"
        style={{
          fontWeight: 500,
          color: active ? "var(--accent)" : "var(--label-primary)",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        {trailing && (
          <span
            className="hig-caption-1"
            style={{
              color: "var(--accent)",
              fontWeight: 600,
              padding: "0.0625rem 0.4375rem",
              borderRadius: "999px",
              background: "var(--accent-fill)",
              flexShrink: 0,
            }}
          >
            {trailing}
          </span>
        )}
      </div>
      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}
      >
        {description}
      </div>
    </button>
  );
}

/* ── Visual: arrows between cards / loop-back connector ─────────── */

function ChainArrow({ hint }: { hint: string }) {
  return (
    <div
      title={hint}
      aria-hidden
      style={{
        position: "absolute",
        bottom: "-1.4375rem",
        left: "50%",
        transform: "translateX(-50%)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "1.625rem",
        height: "1.625rem",
        borderRadius: "999px",
        background: "var(--bg-system)",
        border: "0.5px solid var(--separator)",
        boxShadow: "var(--shadow-1)",
        zIndex: 2,
        color: "var(--label-secondary)",
      }}
    >
      <span style={{ fontSize: "0.875rem", lineHeight: 1 }}>↓</span>
    </div>
  );
}

/** Modal that pops as soon as a back-link is staged in the LinkSlot.
 *  The user must pick a run mode — frequency (N cycles) or infinite —
 *  before the back-link sticks. Cancel reverts the link entirely so
 *  the chain doesn't get left in a partially-looped state. */
function LoopModeModal({
  sourceRule,
  targetRule,
  initialMode,
  onCancel,
  onApply,
}: {
  sourceRule: number;
  targetRule: number;
  initialMode: LoopMode | null;
  onCancel: () => void;
  onApply: (mode: LoopMode) => void;
}) {
  const [choice, setChoice] = useState<"frequency" | "infinite">(
    initialMode?.kind === "infinite" ? "infinite" : "frequency",
  );
  const [cycles, setCycles] = useState<number>(
    initialMode?.kind === "frequency" ? initialMode.cycles : DEFAULT_LOOP_CYCLES,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isSelf = sourceRule === targetRule;
  const headline = isSelf
    ? `Self-link on Rule ${sourceRule}`
    : `Loop detected · Rule ${sourceRule} → Rule ${targetRule}`;
  const subhead = isSelf
    ? "Rule fires repeatedly using its own deposit. How long should it run?"
    : `Rule ${sourceRule}'s output funds Rule ${targetRule} again, closing a cycle. How long should the loop run?`;

  const apply = () => {
    if (choice === "frequency") {
      const n = Math.max(1, Math.floor(cycles));
      onApply({ kind: "frequency", cycles: n });
    } else {
      onApply({ kind: "infinite" });
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 320,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "hig-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "24rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 0.5rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            {headline}
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            {subhead}
          </div>
        </div>

        <div style={{ padding: "0.5rem 1rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <ModeRadio
            checked={choice === "frequency"}
            onCheck={() => setChoice("frequency")}
            label="Frequency"
            description={
              isSelf
                ? "Fire N times then stop. The deposit covers all N cycles."
                : "Loop N cycles then stop. The first rule funds cycle 1; the loop funds the rest."
            }
            trailing={
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4375rem",
                }}
              >
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  value={cycles}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v) || v < 1) return;
                    setCycles(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setChoice("frequency");
                      apply();
                    }
                  }}
                  onFocus={() => setChoice("frequency")}
                  className="hig-footnote"
                  style={{
                    width: "5rem",
                    padding: "0.3125rem 0.5rem",
                    borderRadius: "0.4375rem",
                    border: "0.5px solid var(--separator)",
                    background: "var(--bg-system)",
                    color: "var(--label-primary)",
                    fontFeatureSettings: '"tnum"',
                  }}
                />
                <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
                  cycles
                </span>
              </div>
            }
          />
          <ModeRadio
            checked={choice === "infinite"}
            onCheck={() => setChoice("infinite")}
            label="Infinite"
            description={
              isSelf
                ? "Fires until the deposit runs out. The deposit covers many cycles upfront."
                : "Runs while the loop keeps funding itself. Stops when any rule runs dry."
            }
          />
        </div>

        <div style={{ display: "flex", borderTop: "0.5px solid var(--separator)" }}>
          <button
            onClick={onCancel}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 400,
              borderRight: "0.5px solid var(--separator)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={apply}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Confirmation modal for killing a forward link that would orphan
 *  filled-out downstream rules. Shows how many rules will be deleted
 *  so the user can decide whether to keep them. */
function KillCascadeModal({
  cardLabel,
  downstreamCount,
  filledCount,
  onCancel,
  onConfirm,
}: {
  cardLabel: number;
  downstreamCount: number;
  filledCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const ruleWord = downstreamCount === 1 ? "rule" : "rules";
  const filledNote =
    filledCount === downstreamCount
      ? `${downstreamCount} ${ruleWord} below this one will be deleted.`
      : `${downstreamCount} ${ruleWord} below this one will be deleted, including ${filledCount} that ${filledCount === 1 ? "has" : "have"} content.`;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 320,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "hig-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "22rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 1rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            Cut chain after Rule {cardLabel}?
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            {filledNote}
          </div>
        </div>
        <div style={{ display: "flex", borderTop: "0.5px solid var(--separator)" }}>
          <button
            onClick={onCancel}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 400,
              borderRight: "0.5px solid var(--separator)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--red)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cut & delete
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeRadio({
  checked,
  onCheck,
  label,
  description,
  trailing,
}: {
  checked: boolean;
  onCheck: () => void;
  label: string;
  description: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onCheck}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.6875rem 0.875rem",
        borderRadius: "0.625rem",
        background: checked
          ? "color-mix(in oklab, var(--accent) 10%, transparent)"
          : "var(--fill-4)",
        border: checked
          ? "0.5px solid var(--accent)"
          : "0.5px solid var(--separator)",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.625rem",
        }}
      >
        <span
          aria-hidden
          style={{
            width: "1rem",
            height: "1rem",
            borderRadius: "999px",
            border: checked
              ? "0.4375rem solid var(--accent)"
              : "1.25px solid var(--label-tertiary)",
            background: checked ? "var(--accent)" : "transparent",
            flexShrink: 0,
            transition: "border-width 80ms",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="hig-subheadline"
            style={{
              fontWeight: 500,
              color: checked ? "var(--accent)" : "var(--label-primary)",
            }}
          >
            {label}
          </div>
          <div
            className="hig-caption-1"
            style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}
          >
            {description}
          </div>
        </div>
        {trailing && <div style={{ flexShrink: 0 }}>{trailing}</div>}
      </div>
    </button>
  );
}

/** Curved SVG arrow that visually connects the loop tail (the last
 *  card's bottom-right) to the loop head (the first card's top-right).
 *  For 1-card self-loops, the tail and head are the same card and the
 *  arrow becomes a tight curl on the right side. The path is computed
 *  in the parent (ref-measured); we render it inside an absolutely-
 *  positioned SVG that overlays the chain container. */
function LoopBackSvg({
  path,
  width,
  height,
  label,
}: {
  path: string;
  width: number;
  height: number;
  label: string;
}) {
  // Use raw pixel coordinates (no viewBox). The SVG fills the chain
  // container; curve control points may extend to the right of the
  // container's width, which `overflow: visible` keeps drawable.
  return (
    <svg
      role="img"
      aria-label={label}
      width={width + 96}
      height={height + 16}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="loopArrowhead"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
      </defs>
      <path
        d={path}
        stroke="var(--accent)"
        strokeWidth={1.75}
        fill="none"
        strokeDasharray="6 4"
        markerEnd="url(#loopArrowhead)"
        opacity={0.78}
      />
    </svg>
  );
}

/* ── ChainSaveBar — top-level Save & Run for chain mode ─────────── */

function ChainSaveBar({
  ready,
  error,
  cards,
  loopMode,
  hasBridgedLink,
  onSave,
}: {
  ready: boolean;
  error: ChainValidationError | null;
  cards: number;
  loopMode: LoopMode | null;
  hasBridgedLink: boolean;
  onSave: () => void;
}) {
  const errorMsg = error ? humanizeChainError(error) : null;
  let title: string;
  if (cards === 1 && loopMode) {
    title = "Self-link rule";
  } else if (loopMode) {
    title = `${cards}-rule cycle`;
  } else {
    title = `${cards}-rule chain`;
  }
  let detail: string;
  if (errorMsg) {
    detail = errorMsg;
  } else if (cards === 1 && loopMode?.kind === "frequency") {
    detail = `Rule fires ${loopMode.cycles} times. The deposit covers all cycles.`;
  } else if (cards === 1 && loopMode?.kind === "infinite") {
    detail = "Rule keeps firing until the deposit runs out.";
  } else if (loopMode?.kind === "frequency") {
    detail = `Loop runs ${loopMode.cycles} times. First rule funds cycle 1; the loop funds the rest.`;
  } else if (loopMode?.kind === "infinite") {
    detail = "Loop runs while it keeps funding itself. Stops when any rule runs dry.";
  } else {
    detail =
      "Created in one transaction. Only the first rule is funded upfront; later rules pick up funding from the previous rule's swap.";
  }
  if (hasBridgedLink && !errorMsg) {
    detail += " Bridge step adds ~0.5% slippage per cycle.";
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        padding: "0.875rem 1.125rem",
        background: "var(--bg-system)",
        border: "0.5px solid var(--separator)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          className="hig-subheadline"
          style={{
            fontWeight: 500,
            color: "var(--label-primary)",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          {title}
          {loopMode && (
            <span
              className="hig-caption-1"
              style={{
                padding: "0.0625rem 0.4375rem",
                borderRadius: "999px",
                background: "var(--accent-fill)",
                color: "var(--accent)",
                fontWeight: 600,
              }}
            >
              ↻{" "}
              {loopMode.kind === "infinite"
                ? "infinite"
                : `${loopMode.cycles}×`}
            </span>
          )}
        </div>
        <div
          className="hig-footnote"
          style={{ color: errorMsg ? "var(--red)" : "var(--label-secondary)" }}
        >
          {detail}
        </div>
      </div>
      <button
        disabled={!ready}
        onClick={onSave}
        className="hig-body"
        style={{
          padding: "0.5rem 1.125rem",
          borderRadius: "999px",
          background: ready ? "var(--accent)" : "var(--fill-3)",
          color: ready ? "white" : "var(--label-tertiary)",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          cursor: ready ? "pointer" : "not-allowed",
          flexShrink: 0,
          boxShadow: ready ? "0 1px 2px rgba(0,0,0,0.10)" : "none",
        }}
      >
        <Check size={14} strokeWidth={2} />{" "}
        {loopMode ? "Save & Run Cycle" : "Save & Run Chain"}
      </button>
    </div>
  );
}

function humanizeChainError(err: ChainValidationError): string {
  switch (err.kind) {
    case "non_swap_action":
      return `Rule ${err.nodeIndex + 1}: chain rules must be Swap actions.`;
    case "head_must_have_seed_amount":
      return `Rule ${err.nodeIndex + 1}: head rule needs a positive amount.`;
  }
}
