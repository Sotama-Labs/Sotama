/** Pair-orientation helpers. The bot owns the canonical onchain/underlying
 *  view of every pair; this module derives the display label, pair class, and
 *  reference status from a PairConfig plus the freshest tick metadata. */

import {
  inferPairClass,
  pairDisplayLabel,
  referenceStatusFor,
  type PairClass,
  type ReferenceStatus,
} from "@sotama/market-core";
import type { PairConfig, TimeRegime } from "@sotama/market-core";

export type PairOrientation = {
  pairClass: PairClass;
  displayLabel: string;
  referenceStatus: ReferenceStatus;
};

export function deriveOrientation(args: {
  pair: PairConfig;
  timeRegime: TimeRegime | null | undefined;
  pythFreshnessLagMs?: number | null;
  maxPythFreshnessLagMs?: number | null;
}): PairOrientation {
  const pairClass = inferPairClass(args.pair);
  return {
    pairClass,
    displayLabel: pairDisplayLabel(args.pair),
    referenceStatus: referenceStatusFor({
      pairClass,
      timeRegime: args.timeRegime ?? null,
      pythFreshnessLagMs: args.pythFreshnessLagMs ?? null,
      maxPythFreshnessLagMs: args.maxPythFreshnessLagMs ?? null,
    }),
  };
}
