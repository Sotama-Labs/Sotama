"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Option<T extends string> = { value: T; label: string };

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
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const c = containerRef.current;
    const b = buttonRefs.current[value];
    if (!c || !b) return;
    const cRect = c.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    setThumb({ left: bRect.left - cRect.left, width: bRect.width, ready: true });
  }, [value, options.length]);

  useEffect(() => {
    const onResize = () => {
      const c = containerRef.current;
      const b = buttonRefs.current[value];
      if (!c || !b) return;
      const cRect = c.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      setThumb({ left: bRect.left - cRect.left, width: bRect.width, ready: true });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [value]);

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
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "0.25rem",
          bottom: "0.25rem",
          left: thumb.left,
          width: thumb.width,
          background: "var(--bg-system)",
          borderRadius: "0.5625rem",
          boxShadow:
            "0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.10), 0 3px 8px rgba(0,0,0,0.08), inset 0 0.5px 0 rgba(255,255,255,0.30)",
          transition: thumb.ready
            ? "left 280ms cubic-bezier(0.32, 0.72, 0, 1), width 280ms cubic-bezier(0.32, 0.72, 0, 1)"
            : "none",
          opacity: thumb.ready ? 1 : 0,
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
              fontWeight: selected ? 600 : 500,
              letterSpacing: "-0.014em",
              color: selected ? "var(--label-primary)" : "var(--label-secondary)",
              borderRadius: "0.5625rem",
              cursor: "pointer",
              transition: "color 200ms, font-weight 200ms",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </nav>
  );
}
