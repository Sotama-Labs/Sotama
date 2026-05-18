import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Render the cell for row `row`. */
  render: (row: T) => ReactNode;
  /** Optional CSS text alignment for both header and cell. */
  align?: "left" | "right";
  /** Tabular numbers — add the `bt-num` class. */
  numeric?: boolean;
  /** Optional cell color override per row (e.g., signed coloring). */
  color?: (row: T) => string | undefined;
  /** Minimum width for the column in px so the table doesn't squeeze. */
  minWidth?: number;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidth,
  emptyMessage = "No data in the current window.",
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  minWidth?: number;
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: 0 }}>
        {emptyMessage}
      </p>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          minWidth: minWidth ?? Math.max(640, columns.length * 96),
        }}
      >
        <thead>
          <tr
            className="hig-caption-1"
            style={{
              color: "var(--label-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontSize: "0.6875rem",
            }}
          >
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  padding: "0.5rem 0.35rem",
                  textAlign: col.align ?? (col.numeric ? "right" : "left"),
                  whiteSpace: "nowrap",
                  fontWeight: 500,
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} style={{ borderTop: "1px solid var(--separator)" }}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`hig-footnote ${col.numeric ? "bt-num" : ""}`}
                  style={{
                    padding: "0.625rem 0.35rem",
                    textAlign: col.align ?? (col.numeric ? "right" : "left"),
                    color: col.color?.(row) ?? "var(--label-primary)",
                  }}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
