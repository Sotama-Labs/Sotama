"use client";

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      className="fade-slide"
      key={message}
      style={{
        position: "fixed",
        bottom: "2rem",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "0.625rem 1.125rem",
        background: "var(--material-popover)",
        backdropFilter: "saturate(180%) blur(50px)",
        WebkitBackdropFilter: "saturate(180%) blur(50px)",
        color: "var(--label-primary)",
        border: "0.5px solid var(--separator)",
        borderRadius: "999px",
        boxShadow: "var(--shadow-popover)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontFamily: "var(--hig-font)",
        fontSize: "0.9375rem",
        fontWeight: 500,
        letterSpacing: "-0.016em",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="var(--green)" />
        <path d="M5 8.2 L7 10 L11.5 5.5" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {message}
    </div>
  );
}
