"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  width = 280,
}: {
  anchorRef: RefObject<HTMLButtonElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const popRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2));
    setPos({ top: r.bottom + 8, left });
  }, [open, anchorRef, width]);

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

  if (!open) return null;
  return (
    <div
      ref={popRef}
      className="popover-anim"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: 100,
        background: "var(--material-popover)",
        backdropFilter: "saturate(180%) blur(50px)",
        WebkitBackdropFilter: "saturate(180%) blur(50px)",
        border: "0.5px solid var(--separator)",
        borderRadius: "0.75rem",
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}
