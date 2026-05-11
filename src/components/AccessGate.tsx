"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "sotama:access:v1";
const CODE = "STNL"; // case-insensitive — matches `${input}.toUpperCase() === CODE`

/**
 * Soft launch gate. Blocks the app until a user types the access code.
 *
 * **Not security:** anyone with devtools can flip the localStorage value
 * or read this source. It's a "are you on the invite list" speed bump,
 * not an authentication wall.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  // null = checking localStorage (avoids SSR/hydration flash)
  // false = blocked (show gate)
  // true = granted (render children)
  const [granted, setGranted] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    try {
      setGranted(window.localStorage.getItem(STORAGE_KEY) === CODE);
    } catch {
      setGranted(false);
    }
  }, []);

  if (granted === null) return null;
  if (granted) return <>{children}</>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim().toUpperCase() === CODE) {
      try {
        window.localStorage.setItem(STORAGE_KEY, CODE);
      } catch {
        /* private browsing — granted for this session only */
      }
      setGranted(true);
    } else {
      setError(true);
      setInput("");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg-system)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.875rem",
          width: "100%",
          maxWidth: "18rem",
          padding: "1.5rem",
        }}
      >
        <div
          className="hig-headline"
          style={{
            textAlign: "center",
            color: "var(--label-primary)",
            fontWeight: 600,
          }}
        >
          Access required
        </div>
        <input
          autoFocus
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (error) setError(false);
          }}
          placeholder="Code"
          aria-label="Access code"
          style={{
            padding: "0.625rem 0.875rem",
            background: "var(--fill-3)",
            border: `0.5px solid ${error ? "var(--red)" : "var(--separator)"}`,
            borderRadius: "0.5rem",
            color: "var(--label-primary)",
            fontSize: "0.9375rem",
            textAlign: "center",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            outline: "none",
          }}
        />
        {error && (
          <div
            className="hig-footnote"
            style={{
              color: "var(--red)",
              textAlign: "center",
              margin: "-0.25rem 0",
            }}
          >
            Incorrect code
          </div>
        )}
        <button
          type="submit"
          disabled={!input.trim()}
          style={{
            padding: "0.625rem 0.875rem",
            background: input.trim() ? "var(--accent)" : "var(--fill-2)",
            color: input.trim() ? "white" : "var(--label-tertiary)",
            border: "none",
            borderRadius: "0.5rem",
            fontWeight: 500,
            fontSize: "0.9375rem",
            cursor: input.trim() ? "pointer" : "not-allowed",
            transition: "background 120ms",
          }}
        >
          Enter
        </button>
      </form>
    </div>
  );
}
