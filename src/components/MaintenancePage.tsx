export function MaintenancePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background:
          "radial-gradient(circle at 50% 0%, var(--bg-system-3), var(--bg-grouped) 32rem)",
      }}
    >
      <section
        aria-labelledby="maintenance-title"
        style={{
          width: "100%",
          maxWidth: "30rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1.25rem",
          textAlign: "center",
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
          <p
            className="hig-footnote"
            style={{
              margin: 0,
              color: "var(--orange)",
              fontWeight: 600,
              textTransform: "uppercase",
            }}
          >
            Beta
          </p>
          <h1
            id="maintenance-title"
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
          <a
            href="/demo"
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
              textDecoration: "none",
              boxShadow: "var(--shadow-1)",
            }}
          >
            Explore the demo
          </a>
          <a
            href="https://sotama.xyz"
            style={{
              color: "var(--label-secondary)",
              fontSize: "0.875rem",
              lineHeight: "1.125rem",
              textDecoration: "none",
            }}
          >
            Visit sotama.xyz
          </a>
        </div>
      </section>
    </main>
  );
}
