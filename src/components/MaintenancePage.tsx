"use client";

/* ─────────────────────────────────────────────────────────────────────
   "Still being built" gate.

   Renders the full demo workspace behind a heavily-blurred modal scrim.
   "Explore the demo" dismisses the modal in place, revealing the live
   demo underneath — it never navigates away. "Go back to sotama.xyz"
   leaves for the marketing site.
   ───────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { AutomationWorkspace } from "@/components/AutomationWorkspace";

export function MaintenancePage() {
  const [gateOpen, setGateOpen] = useState(true);

  useEffect(() => {
    if (!gateOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGateOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [gateOpen]);

  return (
    <>
      <AutomationWorkspace />

      {gateOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="gate-title"
          onClick={() => setGateOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            background: "rgba(0,0,0,0.32)",
            backdropFilter: "saturate(140%) blur(32px)",
            WebkitBackdropFilter: "saturate(140%) blur(32px)",
            animation: "hig-fade-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          <section
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "30rem",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "1.25rem",
              padding: "2rem 1.75rem",
              textAlign: "center",
              background: "var(--bg-system)",
              borderRadius: "var(--radius-sheet)",
              border: "0.5px solid var(--separator)",
              boxShadow: "var(--shadow-popover)",
              animation: "hig-pop-in 280ms cubic-bezier(0.32, 0.72, 0, 1)",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.625rem",
                padding: "0.5rem 0.875rem 0.5rem 0.625rem",
                background: "var(--material-chrome)",
                backdropFilter: "saturate(180%) blur(40px)",
                WebkitBackdropFilter: "saturate(180%) blur(40px)",
                border: "0.5px solid var(--separator)",
                borderRadius: "0.625rem",
                boxShadow: "var(--shadow-1)",
              }}
            >
              <svg
                width="1.5em"
                height="1.5em"
                viewBox="240 140 320 320"
                fill="none"
                style={{ flexShrink: 0, fontSize: "1rem" }}
              >
                <path d="M 300 150 L 380 150 L 380 300 L 300 380 Z" fill="var(--label-primary)" />
                <path d="M 300 420 L 380 340 L 380 450 L 300 450 Z" fill="var(--label-primary)" />
                <path d="M 420 150 L 500 150 L 500 180 L 420 260 Z" fill="var(--label-primary)" />
                <path d="M 420 300 L 500 220 L 500 450 L 420 450 Z" fill="var(--label-primary)" />
                <path d="M 260 446 L 260 434 L 540 154 L 540 166 Z" fill="#D85C30" />
              </svg>
              <span
                className="hig-subheadline"
                style={{
                  fontWeight: 600,
                  fontSize: "1.125rem",
                  lineHeight: "1.375rem",
                }}
              >
                Sotama
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
              <h1
                id="gate-title"
                className="hig-title-1"
                style={{ margin: 0, color: "var(--label-primary)" }}
              >
                Sotama is still being built
              </h1>
              <p
                className="hig-body"
                style={{
                  margin: 0,
                  color: "var(--label-secondary)",
                  textWrap: "pretty",
                }}
              >
                Due to the high costs of data providers, we have temporarily disabled
                the application. However, you can check out the demo site by clicking
                the button below.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.875rem",
              }}
            >
              <button
                type="button"
                onClick={() => setGateOpen(false)}
                style={{
                  minHeight: "2.75rem",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 1.25rem",
                  background: "var(--accent)",
                  borderRadius: "var(--radius-control-m)",
                  color: "white",
                  fontWeight: 600,
                  fontSize: "0.9375rem",
                  lineHeight: "1.25rem",
                  cursor: "pointer",
                  boxShadow: "var(--shadow-1)",
                }}
              >
                Explore the demo
              </button>
              <a
                href="https://sotama.xyz"
                style={{
                  color: "var(--label-secondary)",
                  fontSize: "0.875rem",
                  lineHeight: "1.125rem",
                  textDecoration: "none",
                }}
              >
                Go back to sotama.xyz
              </a>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
