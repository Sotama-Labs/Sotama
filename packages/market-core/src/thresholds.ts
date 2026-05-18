/** Quantile of a numeric array, linear interpolation between order statistics. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) throw new Error("empty");
  if (q < 0 || q > 1) throw new Error("q out of range");
  const sorted = [...values].sort((a, b) => a - b);
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  const loVal = sorted[lo] as number;
  const hiVal = sorted[hi] as number;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/** Fixed-capacity rolling window for streaming quantile estimation.
 *  O(n) push (Array.shift) is acceptable for V1 volumes; revisit with
 *  a ring buffer if profiling shows it. */
export class RollingQuantileWindow {
  private buf: number[] = [];
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity >= 1");
  }
  push(x: number): void {
    this.buf.push(x);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  q(p: number): number | null {
    if (this.buf.length === 0) return null;
    return quantile(this.buf, p);
  }
  get size(): number {
    return this.buf.length;
  }
}
