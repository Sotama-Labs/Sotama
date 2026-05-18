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
    <div className="bt-table-wrap">
      <table
        className="bt-table"
        style={{
          minWidth: minWidth ?? Math.max(640, columns.length * 96),
        }}
      >
        <thead>
          <tr className="hig-caption-1 bt-table-head-row">
            {columns.map((col) => (
              <th
                key={col.key}
                className="bt-table-heading"
                style={{
                  textAlign: col.align ?? (col.numeric ? "right" : "left"),
                  minWidth: col.minWidth,
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className="bt-table-row">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`hig-footnote bt-table-cell ${col.numeric ? "bt-num" : ""}`}
                  style={{
                    textAlign: col.align ?? (col.numeric ? "right" : "left"),
                    color: col.color?.(row) ?? "var(--label-primary)",
                    minWidth: col.minWidth,
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
