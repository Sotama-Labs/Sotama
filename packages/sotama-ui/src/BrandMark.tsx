export function BrandMark({ subtitle }: { subtitle?: string }) {
  return (
    <div
      style={{
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
        width: "fit-content",
      }}
    >
      <svg
        width="1.5em"
        height="1.5em"
        viewBox="240 140 320 320"
        fill="none"
        style={{ flexShrink: 0, fontSize: "1rem" }}
        aria-hidden
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
      {subtitle ? (
        <span
          className="hig-caption-1"
          style={{ color: "var(--label-secondary)", marginLeft: "0.125rem" }}
        >
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}
