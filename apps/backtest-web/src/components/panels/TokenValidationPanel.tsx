import type { TokenValidationSnapshot } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";

const COLOR: Record<TokenValidationSnapshot["status"], string> = {
  VERIFIED_ONCHAIN: "var(--green)",
  DECIMALS_CONFIG_ONLY: "var(--orange)",
  UNVERIFIED: "var(--label-secondary)",
  REJECTED: "var(--red)",
};

const LABEL: Record<TokenValidationSnapshot["status"], string> = {
  VERIFIED_ONCHAIN: "Verified on-chain",
  DECIMALS_CONFIG_ONLY: "Decimals from config",
  UNVERIFIED: "Unverified",
  REJECTED: "Rejected",
};

export function TokenValidationPanel({
  snapshot,
}: {
  snapshot: TokenValidationSnapshot;
}) {
  return (
    <Section
      title="Token validation"
      subtitle="On-chain mint authority, decimals, and Token-2022 extensions. Decimals-from-config is a transitional state."
      action={
        <span
          className="hig-caption-1"
          style={{
            color: COLOR[snapshot.status],
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: "0.6875rem",
          }}
        >
          {LABEL[snapshot.status]}
        </span>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4375rem" }}>
        <Row label="Mint" value={shorten(snapshot.mint)} mono />
        <Row label="Decimals" value={String(snapshot.decimals)} />
        <Row label="Token program" value={snapshot.tokenProgram ?? "—"} mono />
        <Row label="Reason" value={snapshot.reason} />
      </div>
    </Section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="hig-footnote"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 1fr) minmax(0, 3fr)",
        gap: "0.5rem",
      }}
    >
      <span style={{ color: "var(--label-tertiary)" }}>{label}</span>
      <span
        style={{
          color: "var(--label-primary)",
          fontFamily: mono ? "var(--hig-mono)" : undefined,
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function shorten(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 8)}…${mint.slice(-6)}`;
}
