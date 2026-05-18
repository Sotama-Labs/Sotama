/** DB row → market-core observation shape adapters.
 *
 *  Each market-core analyzer (pair readiness, two-size backtest, hold horizon
 *  replay, stat summary) takes a narrow set of fields. Adapters live here so
 *  the handlers stay focused on orchestration. */

import type {
  BasisObservationRow,
} from "@sotama/db";
import type {
  HoldHorizonObservation,
  PairReadinessObservation,
  StatObservation,
  TwoSizeBacktestObservation,
} from "@sotama/market-core";

export function toReadinessObservation(b: BasisObservationRow): PairReadinessObservation {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    pythFeedUpdateTimestampUs: b.pythFeedUpdateTimestampUs,
    quoteRequestMs: b.quoteRequestMs,
    basisAgeMs: b.basisAgeMs,
    timeRegime: b.timeRegime,
    qualityStatus: b.qualityStatus,
  };
}

export function toBacktestObservation(b: BasisObservationRow): TwoSizeBacktestObservation {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    netBps: b.netBps,
    qualityStatus: b.qualityStatus,
  };
}

export function toHoldHorizonObservation(b: BasisObservationRow): HoldHorizonObservation {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    netBps: b.netBps,
    qualityStatus: b.qualityStatus,
  };
}

export function toStatObservation(b: BasisObservationRow): StatObservation {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    qualityStatus: b.qualityStatus,
    timeRegime: b.timeRegime,
  };
}
