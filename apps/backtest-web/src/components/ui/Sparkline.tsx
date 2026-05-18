/** Single-color, single-line sparkline. Server-component-safe — pure SVG. */
export function Sparkline({
  values,
  width = 160,
  height = 40,
  stroke = "var(--accent)",
  zeroLine = false,
  ariaLabel,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  stroke?: string;
  zeroLine?: boolean;
  ariaLabel?: string;
}) {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) {
    return (
      <div
        className="hig-caption-1"
        style={{ width, height, display: "grid", placeItems: "center", color: "var(--label-tertiary)" }}
        aria-label={ariaLabel ?? "no data"}
      >
        —
      </div>
    );
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min || 1;
  const padded = 6;
  const xFor = (i: number) =>
    padded + (i * (width - padded * 2)) / Math.max(1, values.length - 1);
  const yFor = (v: number) =>
    padded + (height - padded * 2) * (1 - (v - min) / range);
  let d = "";
  let started = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    if (!started) {
      d += `M${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`;
      started = true;
    } else {
      d += ` L${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`;
    }
  });

  return (
    <svg
      role="img"
      aria-label={ariaLabel ?? "sparkline"}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: "block" }}
    >
      {zeroLine && min < 0 && max > 0 ? (
        <line
          x1={0}
          x2={width}
          y1={yFor(0)}
          y2={yFor(0)}
          stroke="var(--separator)"
          strokeDasharray="2 3"
        />
      ) : null}
      <path d={d} stroke={stroke} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
