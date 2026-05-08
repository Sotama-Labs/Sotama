"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Align = "center" | "start" | "end";

const VIEWPORT_MARGIN = 12;

export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  width = 360,
  align = "center",
}: {
  anchorRef: RefObject<HTMLButtonElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: Align;
}) {
  const [pos, setPos] = useState({
    top: 0,
    left: 0,
    effectiveWidth: width,
    maxHeight: 0,
  });
  const popRef = useRef<HTMLDivElement | null>(null);

  const reposition = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const maxWidth =
      typeof window !== "undefined"
        ? Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2)
        : width;
    const effectiveWidth = Math.min(width, maxWidth);
    const raw =
      align === "start"
        ? r.left
        : align === "end"
        ? r.right - effectiveWidth
        : r.left + r.width / 2 - effectiveWidth / 2;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(window.innerWidth - effectiveWidth - VIEWPORT_MARGIN, raw),
    );

    // Vertical placement: prefer below the anchor, but if the
    // available room above is meaningfully larger AND below is too
    // tight, flip above. Either way cap maxHeight to the available
    // space minus a viewport margin.
    const gap = 8;
    const spaceBelow = vh - r.bottom - gap - VIEWPORT_MARGIN;
    const spaceAbove = r.top - gap - VIEWPORT_MARGIN;
    const MIN_USABLE = 220;
    const flip = spaceBelow < MIN_USABLE && spaceAbove > spaceBelow;
    const maxHeight = Math.max(MIN_USABLE, flip ? spaceAbove : spaceBelow);
    const top = flip
      ? Math.max(VIEWPORT_MARGIN, r.top - gap - maxHeight)
      : r.bottom + gap;

    setPos({ top, left, effectiveWidth, maxHeight });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchorRef, width, align]);

  useEffect(() => {
    if (!open) return;
    const onChange = () => reposition();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current && !popRef.current.contains(t) && anchorRef.current && !anchorRef.current.contains(t)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popRef}
      className="popover-anim popover-scroll"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.effectiveWidth,
        maxHeight: pos.maxHeight || undefined,
        zIndex: 100,
        background: "var(--material-popover)",
        backdropFilter: "saturate(180%) blur(50px)",
        WebkitBackdropFilter: "saturate(180%) blur(50px)",
        border: "0.5px solid var(--separator)",
        borderRadius: "0.875rem",
        boxShadow: "var(--shadow-popover)",
        // Vertical scroll on overflow — keeps the confirm button on
        // every editor reachable regardless of viewport height.
        overflowY: "auto",
        overflowX: "hidden",
        overscrollBehavior: "contain",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
