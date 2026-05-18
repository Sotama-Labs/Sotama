import type { PairResearchVerdict, PairResearchVerdictStatus } from "@sotama/market-core";

export const VERDICT_ORDER: PairResearchVerdictStatus[] = [
  "CANDIDATE",
  "PAPER_EDGE",
  "COLLECT_MORE",
  "NO_EDGE",
  "NOT_READY",
];

export function verdictLabel(status: PairResearchVerdictStatus): string {
  switch (status) {
    case "CANDIDATE":
      return "Candidate";
    case "PAPER_EDGE":
      return "Paper edge";
    case "COLLECT_MORE":
      return "Collecting";
    case "NO_EDGE":
      return "No edge";
    case "NOT_READY":
      return "Not ready";
  }
}

export function verdictGroupHeadline(status: PairResearchVerdictStatus): string {
  switch (status) {
    case "CANDIDATE":
      return "Research candidates";
    case "PAPER_EDGE":
      return "Paper edge";
    case "COLLECT_MORE":
      return "Collecting clean samples";
    case "NO_EDGE":
      return "No edge after cost";
    case "NOT_READY":
      return "Not ready";
  }
}

export function verdictColor(status: PairResearchVerdictStatus): string {
  switch (status) {
    case "CANDIDATE":
      return "var(--green)";
    case "PAPER_EDGE":
      return "var(--accent)";
    case "COLLECT_MORE":
      return "var(--label-secondary)";
    case "NO_EDGE":
      return "var(--orange)";
    case "NOT_READY":
      return "var(--red)";
  }
}

export function verdictBackground(status: PairResearchVerdictStatus): string {
  switch (status) {
    case "CANDIDATE":
      return "rgba(52,199,89,0.14)";
    case "PAPER_EDGE":
      return "var(--accent-fill)";
    case "COLLECT_MORE":
      return "var(--fill-3)";
    case "NO_EDGE":
      return "rgba(255,149,0,0.14)";
    case "NOT_READY":
      return "rgba(255,59,48,0.14)";
  }
}

export function confidenceDots(verdict: PairResearchVerdict): string {
  switch (verdict.confidence) {
    case "HIGH":
      return "● ● ●";
    case "MEDIUM":
      return "● ● ○";
    case "LOW":
      return "● ○ ○";
  }
}
