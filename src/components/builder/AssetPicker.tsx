"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetClass, AssetRef } from "@/lib/types";
import { ASSET_CLASS_LABELS, CLASSES_COMING_SOON, POPULAR_ASSETS } from "@/lib/assets";
import { searchFeedsByClass } from "@/lib/oracles";
import { isValidMintCandidate, resolveToken } from "@/lib/tokens";

const ALL_CLASSES: AssetClass[] = ["Crypto", "Equity", "Commodity", "FX", "Metal"];

/** Resolve a pasted SPL mint to an AssetRef. Used in the Crypto tab so
 *  users can target any tradable Solana token (not just Pyth-listed
 *  ones) — the keeper falls back to Jupiter Price v3 on the
 *  oracle-source side. */
async function resolvePastedMint(input: string): Promise<AssetRef | null> {
  const result = await resolveToken(input);
  if (result.status !== "ok") return null;
  const t = result.token;
  return {
    symbol: t.symbol,
    displaySymbol: t.symbol,
    name: t.name,
    assetClass: "Crypto",
    logo: t.logo,
    mint: t.mint,
    decimals: t.decimals,
    metadataSource: t.metadataSource,
  };
}

export function AssetPicker({
  title,
  selected,
  onBack,
  onSelect,
  /** Restrict the picker to a subset of asset classes. Use when the
   *  caller can only accept certain kinds (e.g. quote pickers want
   *  Crypto only because non-token assets have no Solana mint and
   *  therefore can't be deployed on-chain). */
  allowedClasses,
  /** Asset symbols to render as disabled. Used by the quote picker to
   *  grey out the asset that's already selected as base — there's no
   *  meaningful USD/USD or SOL/SOL trigger and we'd rather show that
   *  visually than silently ignore the click. */
  disabledSymbols,
}: {
  title: string;
  selected: AssetRef | null;
  onBack: () => void;
  onSelect: (a: AssetRef) => void;
  allowedClasses?: ReadonlyArray<AssetClass>;
  disabledSymbols?: ReadonlyArray<string>;
}) {
  const disabledSet = useMemo(
    () => new Set((disabledSymbols ?? []).map((s) => s.toUpperCase())),
    [disabledSymbols],
  );
  const ASSET_CLASSES = useMemo<AssetClass[]>(
    () =>
      allowedClasses && allowedClasses.length > 0
        ? ALL_CLASSES.filter((c) => allowedClasses.includes(c))
        : ALL_CLASSES,
    [allowedClasses],
  );
  const [activeTab, setActiveTab] = useState<AssetClass>(
    selected?.assetClass && ASSET_CLASSES.includes(selected.assetClass)
      ? selected.assetClass
      : ASSET_CLASSES[0] ?? "Crypto",
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [hoveredComingSoon, setHoveredComingSoon] = useState<AssetClass | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchQuery = query.trim();

  useEffect(() => {
    if (!searchQuery) {
      setResults(POPULAR_ASSETS[activeTab]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      // Crypto tab: try to resolve pasted base58 strings as SPL mints
      // first. This lets users target any tradable Solana token (not
      // just Pyth-listed ones) — Jupiter Price v3 covers them on the
      // keeper side via the JUPITER oracle source.
      if (activeTab === "Crypto" && isValidMintCandidate(searchQuery)) {
        const resolved = await resolvePastedMint(searchQuery);
        if (resolved) {
          setResults([resolved]);
          setLoading(false);
          return;
        }
      }
      const found = await searchFeedsByClass(activeTab, searchQuery);
      setResults(found);
      setLoading(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [activeTab, searchQuery]);

  // Reset search and results when tab changes
  const handleTabChange = (tab: AssetClass) => {
    setActiveTab(tab);
    setQuery("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "0.75rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button
          onClick={onBack}
          className="hig-caption-1"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.75rem",
            height: "1.75rem",
            borderRadius: "50%",
            background: "var(--fill-3)",
            color: "var(--label-secondary)",
            flexShrink: 0,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M7 1L3 5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="hig-footnote" style={{ fontWeight: 600, color: "var(--label-primary)" }}>
          {title}
        </span>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "inline-flex",
          padding: "0.125rem",
          background: "var(--fill-3)",
          borderRadius: "0.5rem",
          gap: "0.125rem",
        }}
      >
        {ASSET_CLASSES.map((cls) => {
          const sel = activeTab === cls;
          const comingSoon = CLASSES_COMING_SOON.has(cls);
          const showTooltip = comingSoon && hoveredComingSoon === cls;
          return (
            <div key={cls} style={{ flex: 1, position: "relative" }}>
              <button
                onClick={() => !comingSoon && handleTabChange(cls)}
                disabled={comingSoon}
                onMouseEnter={() => comingSoon && setHoveredComingSoon(cls)}
                onMouseLeave={() => comingSoon && setHoveredComingSoon(null)}
                onFocus={() => comingSoon && setHoveredComingSoon(cls)}
                onBlur={() => comingSoon && setHoveredComingSoon(null)}
                aria-describedby={showTooltip ? `asset-tab-tooltip-${cls}` : undefined}
                className="hig-caption-2"
                style={{
                  width: "100%",
                  padding: "0.25rem 0.375rem",
                  borderRadius: "0.375rem",
                  background: sel ? "var(--bg-system)" : "transparent",
                  color: comingSoon
                    ? "var(--label-quaternary)"
                    : sel
                    ? "var(--label-primary)"
                    : "var(--label-secondary)",
                  fontWeight: sel ? 600 : 400,
                  boxShadow: sel ? "var(--shadow-1)" : "none",
                  transition: "background 120ms",
                  whiteSpace: "nowrap",
                  cursor: comingSoon ? "default" : "pointer",
                }}
              >
                {ASSET_CLASS_LABELS[cls]}
              </button>
              {showTooltip && (
                <div
                  id={`asset-tab-tooltip-${cls}`}
                  role="tooltip"
                  className="hig-caption-2"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 0.375rem)",
                    left: "50%",
                    transform: "translateX(-50%)",
                    padding: "0.25rem 0.5rem",
                    background: "var(--label-primary)",
                    color: "var(--bg-system)",
                    borderRadius: "0.375rem",
                    whiteSpace: "nowrap",
                    boxShadow: "var(--shadow-1)",
                    pointerEvents: "none",
                    zIndex: 10,
                  }}
                >
                  Coming soon
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${ASSET_CLASS_LABELS[activeTab]}…`}
        className="hig-footnote"
        style={{
          padding: "0.5rem 0.625rem",
          background: "var(--fill-3)",
          border: "0.5px solid var(--separator)",
          borderRadius: "0.5rem",
          color: "var(--label-primary)",
          outline: "none",
        }}
        autoFocus
      />

      {/* Results */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", overflowY: "auto", flex: 1 }}>
        {loading ? (
          <div className="hig-footnote" style={{ color: "var(--label-tertiary)", padding: "0.5rem 0.125rem" }}>
            Searching…
          </div>
        ) : results.length === 0 ? (
          <div className="hig-footnote" style={{ color: "var(--label-tertiary)", padding: "0.5rem 0.125rem" }}>
            No results
          </div>
        ) : (
          results.map((a) => {
            const isSel = selected?.symbol === a.symbol && selected?.assetClass === a.assetClass;
            const isDisabled = disabledSet.has(a.symbol.toUpperCase());
            return (
              <button
                key={`${a.assetClass}:${a.symbol}`}
                onClick={() => {
                  if (isDisabled) return;
                  onSelect(a);
                }}
                disabled={isDisabled}
                title={isDisabled ? "Already selected as base — pick a different asset" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0.625rem",
                  borderRadius: "0.5rem",
                  background: isSel ? "var(--fill-4)" : "transparent",
                  transition: "background 80ms",
                  textAlign: "left",
                  opacity: isDisabled ? 0.4 : 1,
                  cursor: isDisabled ? "not-allowed" : "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  {a.logo && (
                    <img
                      src={a.logo}
                      alt=""
                      width={20}
                      height={20}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        objectFit: "cover",
                        flexShrink: 0,
                      }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.0625rem" }}>
                  <span
                    className="hig-footnote"
                    style={{ fontWeight: 600, color: "var(--label-primary)" }}
                  >
                    {a.displaySymbol}
                  </span>
                  {a.name && (
                    <span className="hig-caption-2" style={{ color: "var(--label-secondary)" }}>
                      {a.name}
                    </span>
                  )}
                  </div>
                </div>
                {isSel && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M2.5 7L5.5 10L11.5 4"
                      stroke="var(--accent)"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
