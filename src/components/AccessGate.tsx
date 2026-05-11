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
      {/* Sotama logo top-left — matches the in-app BrandMark, links back
        * to the public waitlist site for visitors without the code. */}
      <a
        href="https://sotama.xyz"
        aria-label="Sotama"
        style={{
          position: "fixed",
          top: "1rem",
          left: "1rem",
          zIndex: 10000,
          display: "flex",
          alignItems: "center",
          gap: "0.625rem",
          padding: "0.4375rem 0.875rem 0.4375rem 0.625rem",
          background: "var(--material-chrome)",
          backdropFilter: "saturate(180%) blur(40px)",
          WebkitBackdropFilter: "saturate(180%) blur(40px)",
          border: "0.5px solid var(--separator)",
          borderRadius: "0.625rem",
          boxShadow: "var(--shadow-1)",
          color: "var(--label-primary)",
          textDecoration: "none",
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
            letterSpacing: "-0.014em",
            fontSize: "1.125rem",
            lineHeight: "1.375rem",
          }}
        >
          Sotama
        </span>
      </a>
      <form
        onSubmit={submit}
        autoComplete="off"
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
          // `one-time-code` is the cleanest signal to iOS Safari, Android
          // Chrome, and password managers (1Password/LastPass/Bitwarden)
          // that this is an ephemeral code field — they suppress the
          // autofill UI, the "Suggest Strong Password" prompt, and the
          // keyboard's password chip. Combined with `name=access-code`,
          // `inputMode=text`, and the ignore-data attrs below to defeat
          // the few PWMs that still try to inject suggestions.
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          name="access-code"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
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
