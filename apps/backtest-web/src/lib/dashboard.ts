/** Re-exports DTOs from market-core under names the dashboard components
 *  expect. Earlier this module talked to `@sotama/db` directly; it now
 *  delegates to the bot's HTTPS read API, since the Postgres host lives
 *  on Fly's private network and isn't reachable from Vercel. */

export type {
  BestSideDto as BestSide,
  BestSpreadDto as BestSpread,
  DashboardSnapshotDto as DashboardSnapshot,
  HeartbeatDto,
  PairPanelDto as PairPanel,
  PairDetailDto,
} from "@sotama/market-core";

export { fetchDashboard as loadDashboardSnapshot, fetchPairDetail } from "./bot-api";
