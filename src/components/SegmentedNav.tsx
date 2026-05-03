"use client";

import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

type Option<T extends string> = { value: T; label: string };

const SPRING = "transform 360ms cubic-bezier(0.32, 0.72, 0, 1)";

export function SegmentedNav<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const thumbVisualRef = useRef<HTMLSpanElement | null>(null);
  const thumbHitRef = useRef<HTMLSpanElement | null>(null);
  const prevRect = useRef<{ left: number; width: number } | null>(null);

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragLeftRef = useRef(0);
  const dragWidthRef = useRef(0);

  const forEachThumb = (cb: (el: HTMLSpanElement) => void) => {
    if (thumbVisualRef.current) cb(thumbVisualRef.current);
    if (thumbHitRef.current) cb(thumbHitRef.current);
  };

  const positionThumb = (animate: boolean) => {
    const c = containerRef.current;
    const b = buttonRefs.current[value];
    if (!c || !b || !thumbVisualRef.current) return;
    const cRect = c.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const next = { left: bRect.left - cRect.left, width: bRect.width };

    if (animate && prevRect.current) {
      const prev = prevRect.current;
      const dx = prev.left - next.left;
      const sx = next.width === 0 ? 1 : prev.width / next.width;

      forEachThumb((t) => {
        t.style.transition = "none";
        t.style.left = `${next.left}px`;
        t.style.width = `${next.width}px`;
        t.style.transform = `translateX(${dx}px) scaleX(${sx})`;
        t.style.opacity = "1";
      });
      thumbVisualRef.current.getBoundingClientRect();
      requestAnimationFrame(() => {
        forEachThumb((t) => {
          t.style.transition = SPRING;
          t.style.transform = "translateX(0) scaleX(1)";
        });
      });
    } else {
      forEachThumb((t) => {
        t.style.transition = "none";
        t.style.left = `${next.left}px`;
        t.style.width = `${next.width}px`;
        t.style.transform = "translateX(0) scaleX(1)";
        t.style.opacity = "1";
      });
    }

    prevRect.current = next;
  };

  useLayoutEffect(() => {
    positionThumb(prevRect.current !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  useEffect(() => {
    const onResize = () => positionThumb(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Snapshot every button's geometry relative to the container, sorted by render order.
  const snapshotButtons = (): Array<{ value: T; left: number; width: number; center: number }> => {
    const c = containerRef.current;
    if (!c) return [];
    const cRect = c.getBoundingClientRect();
    const out: Array<{ value: T; left: number; width: number; center: number }> = [];
    for (const o of options) {
      const btn = buttonRefs.current[o.value];
      if (!btn) continue;
      const r = btn.getBoundingClientRect();
      const left = r.left - cRect.left;
      out.push({ value: o.value, left, width: r.width, center: left + r.width / 2 });
    }
    return out;
  };

  // Given the cursor's horizontal delta from drag-start, return the morphed thumb geometry:
  // its center follows the cursor (clamped to span between first/last button centers), and
  // its width interpolates linearly between the two adjacent button widths.
  const computeMorph = (cursorDeltaX: number): { left: number; width: number } | null => {
    if (!prevRect.current) return null;
    const rects = snapshotButtons();
    if (rects.length === 0) return null;

    const activeCenter = prevRect.current.left + prevRect.current.width / 2;
    const proposed = activeCenter + cursorDeltaX;
    const minC = rects[0].center;
    const maxC = rects[rects.length - 1].center;
    const center = Math.max(minC, Math.min(maxC, proposed));

    let i = 0;
    while (i < rects.length - 1 && center > rects[i + 1].center) i++;
    const a = rects[i];
    const b = rects[Math.min(i + 1, rects.length - 1)];
    const span = b.center - a.center;
    const alpha = span === 0 ? 0 : (center - a.center) / span;
    const width = a.width + alpha * (b.width - a.width);
    const left = center - width / 2;
    return { left, width };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!thumbHitRef.current || !prevRect.current) return;
    e.preventDefault();
    thumbHitRef.current.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    movedRef.current = false;
    dragStartXRef.current = e.clientX;
    dragLeftRef.current = prevRect.current.left;
    dragWidthRef.current = prevRect.current.width;
    forEachThumb((t) => {
      t.style.transition = "none";
    });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current || !prevRect.current) return;
    const dx = e.clientX - dragStartXRef.current;
    if (Math.abs(dx) > 0.5) movedRef.current = true;
    const m = computeMorph(dx);
    if (!m) return;
    dragLeftRef.current = m.left;
    dragWidthRef.current = m.width;
    const active = prevRect.current;
    const tx = m.left - active.left;
    const sx = active.width === 0 ? 1 : m.width / active.width;
    forEachThumb((t) => {
      t.style.transform = `translateX(${tx}px) scaleX(${sx})`;
    });
  };

  const endDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current || !prevRect.current) return;
    draggingRef.current = false;
    if (thumbHitRef.current) {
      try {
        thumbHitRef.current.releasePointerCapture(e.pointerId);
      } catch {
        // pointer may already be released
      }
    }

    if (!movedRef.current) {
      forEachThumb((t) => {
        t.style.transition = "none";
        t.style.transform = "translateX(0) scaleX(1)";
      });
      return;
    }

    const finalLeft = dragLeftRef.current;
    const finalWidth = dragWidthRef.current;
    const finalCenter = finalLeft + finalWidth / 2;

    const rects = snapshotButtons();
    let closest: T = value;
    let closestDist = Infinity;
    for (const r of rects) {
      const d = Math.abs(r.center - finalCenter);
      if (d < closestDist) {
        closestDist = d;
        closest = r.value;
      }
    }

    if (closest !== value) {
      // Hand off to the FLIP effect: prevRect now reflects the morphed visual state, so
      // the tab-change animation departs from exactly where the cursor let go.
      prevRect.current = { left: finalLeft, width: finalWidth };
      onChange(closest);
      return;
    }

    // Same tab — animate transform back to identity. Force a reflow first so the browser
    // commits the SPRING transition before reading the new transform value.
    forEachThumb((t) => {
      t.style.transition = SPRING;
    });
    if (thumbVisualRef.current) thumbVisualRef.current.getBoundingClientRect();
    forEachThumb((t) => {
      t.style.transform = "translateX(0) scaleX(1)";
    });
  };

  const thumbBaseStyle = {
    position: "absolute" as const,
    top: "0.25rem",
    bottom: "0.25rem",
    left: 0,
    width: 0,
    borderRadius: "0.5625rem",
    transformOrigin: "left center" as const,
    willChange: "transform" as const,
    opacity: 0,
  };

  return (
    <nav
      ref={containerRef}
      style={{
        padding: "0.25rem",
        borderRadius: "0.75rem",
        background: "var(--slot-fill)",
        backdropFilter: "saturate(180%) blur(20px)",
        WebkitBackdropFilter: "saturate(180%) blur(20px)",
        boxShadow: "var(--slot-shadow)",
        display: "inline-flex",
        position: "relative",
      }}
    >
      <span
        ref={thumbVisualRef}
        aria-hidden="true"
        style={{
          ...thumbBaseStyle,
          background: "var(--bg-system)",
          boxShadow:
            "0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.10), 0 3px 8px rgba(0,0,0,0.08), inset 0 0.5px 0 rgba(255,255,255,0.30)",
          pointerEvents: "none",
        }}
      />
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              buttonRefs.current[o.value] = el;
            }}
            onClick={() => onChange(o.value)}
            aria-pressed={selected}
            className="hig-subheadline"
            style={{
              position: "relative",
              padding: "0.5625rem 1.375rem",
              fontSize: "1.125rem",
              lineHeight: "1.375rem",
              fontWeight: 600,
              letterSpacing: "-0.014em",
              color: selected ? "var(--label-primary)" : "var(--label-secondary)",
              borderRadius: "0.5625rem",
              cursor: "pointer",
              transition: "color 240ms ease",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
      <span
        ref={thumbHitRef}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          ...thumbBaseStyle,
          background: "transparent",
          cursor: "pointer",
          touchAction: "none",
        }}
      />
    </nav>
  );
}
