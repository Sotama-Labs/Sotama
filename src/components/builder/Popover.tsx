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
  const [pos, setPos] = useState({ top: 0, left: 0, effectiveWidth: width });
  const popRef = useRef<HTMLDivElement | null>(null);

  const reposition = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
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
    setPos({ top: r.bottom + 8, left, effectiveWidth });
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
      className="popover-anim"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.effectiveWidth,
        zIndex: 100,
        background: "var(--material-popover)",
        backdropFilter: "saturate(180%) blur(50px)",
        WebkitBackdropFilter: "saturate(180%) blur(50px)",
        border: "0.5px solid var(--separator)",
        borderRadius: "0.875rem",
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
