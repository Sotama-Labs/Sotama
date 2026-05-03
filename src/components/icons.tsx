import type { CSSProperties } from "react";

export function Chevron({ size = 10, dir = "down" }: { size?: number; dir?: "up" | "down" }) {
  const style: CSSProperties = {
    transform: dir === "up" ? "rotate(180deg)" : "none",
    transition: "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)",
    flexShrink: 0,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={style}>
      <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Check({ size = 14, strokeWidth = 1.7 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M3 7.5 L6 10.5 L11.5 4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Plus({ size = 12, strokeWidth = 1.8 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display: "block" }}>
      <path d="M6 1.5 V10.5 M1.5 6 H10.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function XMark({ size = 8, strokeWidth = 1.4 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="none">
      <path d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function ArrowRight({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 7 L11.5 7 M8 3.5 L11.5 7 L8 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InfoCircle({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 4 V8 M7 10 V10.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill="var(--green)" />
      <path d="M5 8.2 L7 10 L11.5 5.5" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CopyGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <rect x="3.25" y="3.25" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.25 3.25 V2.4 a1 1 0 0 1 1-1 H10.6 a1 1 0 0 1 1 1 V8.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function Sun({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8 1.5 V3" />
        <path d="M8 13 V14.5" />
        <path d="M1.5 8 H3" />
        <path d="M13 8 H14.5" />
        <path d="M3.4 3.4 L4.5 4.5" />
        <path d="M11.5 11.5 L12.6 12.6" />
        <path d="M3.4 12.6 L4.5 11.5" />
        <path d="M11.5 4.5 L12.6 3.4" />
      </g>
    </svg>
  );
}

export function Moon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 19.6289 19.3848" fill="currentColor" aria-hidden="true">
      <path d="M15.1074 13.0859C9.82422 13.0859 6.44531 9.77539 6.44531 4.48242C6.44531 3.38867 6.70898 1.82617 7.06055 1.01562C7.14844 0.791016 7.16797 0.654297 7.16797 0.556641C7.16797 0.292969 6.97266 0 6.5918 0C6.48438 0 6.25 0.0292969 6.03516 0.107422C2.42188 1.55273 0 5.43945 0 9.53125C0 15.2734 4.375 19.375 10.0977 19.375C14.3066 19.375 17.9492 16.8262 19.1602 13.6426C19.248 13.418 19.2676 13.1836 19.2676 13.0957C19.2676 12.7344 18.9648 12.4902 18.6914 12.4902C18.5645 12.4902 18.457 12.5195 18.2715 12.5781C17.5195 12.8223 16.3086 13.0859 15.1074 13.0859Z" />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" style={{ animation: "hig-spin 0.8s linear infinite" }}>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" fill="none" />
      <path d="M7 2 A5 5 0 0 1 12 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}
