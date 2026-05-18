/** Re-exports DTOs from market-core under names the dashboard components
 *  expect. The bot owns these shapes; this module is the only place we
 *  rename them so swapping the wire format requires editing one file. */

export type {
  BestSideDto as BestSide,
  BestSpreadDto as BestSpread,
  CurrentOpportunityDto as CurrentOpportunity,
  DashboardSnapshotDto as DashboardSnapshot,
  HeartbeatDto,
  PairPanelDto as PairPanel,
  PairDetailDto,
  SchedulerTelemetryDto,
} from "@sotama/market-core";

export { fetchDashboard as loadDashboardSnapshot, fetchPairDetail } from "./bot-api";
