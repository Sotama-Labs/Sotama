/** Pair taxonomy.
 *
 *  Bridged crypto, tokenized equities, tokenized metals, tokenized commodities,
 *  and tokenized FX have different research rules. Bridged crypto is 24/7 with
 *  a continuous off-chain reference. Tokenized RWAs only have a live executable
 *  reference during the underlying market session — observations outside that
 *  window are not stat-arb evidence, they are reference-closed snapshots.
 *
 *  V1 derives `PairClass` from `AssetClass`. Later pair-config can override. */

import type { AssetClass } from "./asset";
import type { PairConfig } from "./pair-config";
import type { TimeRegime } from "./time-regime";

export type PairClass =
  | "BRIDGED_CRYPTO"
  | "TOKENIZED_EQUITY"
  | "TOKENIZED_METAL"
  | "TOKENIZED_COMMODITY"
  | "TOKENIZED_FX";

export type ReferenceStatus =
  | "LIVE_REFERENCE"
  | "REFERENCE_CLOSED"
  | "REFERENCE_STALE"
  | "REFERENCE_UNCERTAIN";

export function inferPairClass(pair: PairConfig): PairClass {
  return pairClassForAssetClass(pair.base.assetClass);
}

export function pairClassForAssetClass(assetClass: AssetClass): PairClass {
  switch (assetClass) {
    case "Crypto":
      return "BRIDGED_CRYPTO";
    case "Equity":
      return "TOKENIZED_EQUITY";
    case "Metal":
      return "TOKENIZED_METAL";
    case "Commodity":
      return "TOKENIZED_COMMODITY";
    case "FX":
      return "TOKENIZED_FX";
    default: {
      // Exhaustiveness guard — TypeScript widens AssetClass; if a new variant
      // is added without updating this switch, the cast below will be a
      // never-typed compile error rather than a silent fall-through.
      const _exhaustive: never = assetClass;
      return _exhaustive;
    }
  }
}

export function pairClassLabel(pairClass: PairClass): string {
  switch (pairClass) {
    case "BRIDGED_CRYPTO":
      return "Bridged crypto";
    case "TOKENIZED_EQUITY":
      return "Tokenized equity";
    case "TOKENIZED_METAL":
      return "Tokenized metal";
    case "TOKENIZED_COMMODITY":
      return "Tokenized commodity";
    case "TOKENIZED_FX":
      return "Tokenized FX";
  }
}

export type ReferenceStatusInput = {
  pairClass: PairClass;
  timeRegime: TimeRegime | null | undefined;
  pythFreshnessLagMs?: number | null;
  maxPythFreshnessLagMs?: number | null;
};

/** Map current time-regime + freshness to a reference status the dashboard can
 *  show next to a pair's name. The classification is deliberately conservative:
 *  any pair without a known regime is `REFERENCE_UNCERTAIN`, not `LIVE`. */
export function referenceStatusFor(input: ReferenceStatusInput): ReferenceStatus {
  if (input.timeRegime == null) return "REFERENCE_UNCERTAIN";
  if (
    input.maxPythFreshnessLagMs != null &&
    input.pythFreshnessLagMs != null &&
    input.pythFreshnessLagMs > input.maxPythFreshnessLagMs
  ) {
    return "REFERENCE_STALE";
  }

  switch (input.pairClass) {
    case "BRIDGED_CRYPTO":
      return "LIVE_REFERENCE";
    case "TOKENIZED_EQUITY":
      return input.timeRegime === "US_EQUITY_REGULAR"
        ? "LIVE_REFERENCE"
        : "REFERENCE_CLOSED";
    case "TOKENIZED_METAL":
      return input.timeRegime === "METAL_ACTIVE"
        ? "LIVE_REFERENCE"
        : "REFERENCE_CLOSED";
    case "TOKENIZED_COMMODITY":
    case "TOKENIZED_FX":
      // No fine-grained regime mapping yet — default to LIVE when the regime
      // exists, conservative when not.
      return "LIVE_REFERENCE";
  }
}

export function referenceStatusLabel(status: ReferenceStatus): string {
  switch (status) {
    case "LIVE_REFERENCE":
      return "Live reference";
    case "REFERENCE_CLOSED":
      return "Reference closed";
    case "REFERENCE_STALE":
      return "Reference stale";
    case "REFERENCE_UNCERTAIN":
      return "Reference uncertain";
  }
}
