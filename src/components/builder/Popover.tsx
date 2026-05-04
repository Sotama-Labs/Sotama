"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Align = "center" | "start" | "end";

export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  width = 280,
  align = "center",
}: {
  anchorRef: RefObject<HTMLButtonElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: Align;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const popRef = useRef<HTMLDivElement | null>(null);

  const reposition = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const raw =
      align === "start"
        ? r.left
        : align === "end"
        ? r.right - width
        : r.left + r.width / 2 - width / 2;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, raw));
    setPos({ top: r.bottom + 8, left });
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
  // Portal to body so position:fixed isn't trapped by a transformed ancestor
  // (e.g. the top-center nav wrapper using translateX(-50%)).
  return createPortal(
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
    </div>,
    document.body,
  );
}
